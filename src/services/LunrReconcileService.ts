import axios from "axios";
import fs from "fs";
import path from "path";
import lunr from "lunr";
import {
  ReconcileOutput,
  ReconcileServiceIfc,
  ReconcileInput,
  ReconcileResult,
  ManifestType,
  SingleReconcileQuery,
} from "./ReconcileServiceIfc";
import { inject, injectable } from "tsyringe";
import {
  FieldQueryConfig,
  LunrReconcileServiceConfig,
} from "../config/ProjectConfig";
import {
  collectUnresolvedLabels,
  buildLabelToUriMap,
  injectResolvedUris,
} from "../utils/UriReconciliationHelperV13";
import logger from "../utils/logger";

// Strips diacritics so "eplerenone" matches "éplérénone" in both directions.
// Registered globally once; referenced in both index and search pipelines.
const normalizeAccents = (token: lunr.Token): lunr.Token =>
  token.update((str) => str.normalize("NFD").replace(/[̀-ͯ]/g, ""));
lunr.Pipeline.registerFunction(normalizeAccents, "normalizeAccents");

type SearchMode = "wildcard" | "fuzzy" | "exact";
type SparqlBinding = Record<string, { value: string }>;

/** One binding returned by a field SPARQL query: ?entity + ?value */
type FieldBinding = { entity: string; value: string };

/** Legacy single-query binding: ?entity + optional ?label + optional ?altLabel */
type LegacyBinding = { id: string; label?: string; altLabel?: string };

/** Enriched metadata stored per URI */
type UriData = { label: string; fields: Record<string, string[]> };

@injectable({ token: "LunrReconcileService" })
export class LunrReconcileService implements ReconcileServiceIfc {
  public static DEFAULT_MAX_RESULTS = 10;
  public static DEFAULT_CACHE_SIZE = 1000;
  // Top result must be this much better (relatively) than the 2nd to be a definitive match
  private static MATCH_MIN_GAP = 0.3;

  // Insertion-ordered Map enables O(1) LRU eviction (oldest = first key)
  private memoryCache: Map<string, ReconcileResult[]> = new Map();
  private projectId: string;
  private sparqlEndpoint: string;
  private maxResults: number;
  private cacheSize: number;
  private fieldQueries: FieldQueryConfig[];
  private legacySparqlQuery: string | undefined;
  private indexCachePath: string | undefined;

  private index: lunr.Index | null = null;
  private uriToData: Map<string, UriData> = new Map();
  private indexBuilding: Promise<void> | null = null;

  constructor(
    @inject("project.id") projectId?: string,
    @inject("project.sparqlEndpoint") sparqlEndpoint?: string,
    @inject("reconciliation.config")
    reconciliationConfig?: LunrReconcileServiceConfig,
  ) {
    this.projectId = projectId || "";
    this.sparqlEndpoint = sparqlEndpoint || "";
    this.maxResults =
      reconciliationConfig?.maxResults ??
      LunrReconcileService.DEFAULT_MAX_RESULTS;
    this.cacheSize =
      reconciliationConfig?.cacheSize ??
      LunrReconcileService.DEFAULT_CACHE_SIZE;
    this.indexCachePath = reconciliationConfig?.indexCachePath;

    if (reconciliationConfig?.sparqlQueries?.length) {
      this.fieldQueries = reconciliationConfig.sparqlQueries;
      this.legacySparqlQuery = undefined;
    } else if (reconciliationConfig?.sparqlQuery) {
      this.fieldQueries = [];
      this.legacySparqlQuery = reconciliationConfig.sparqlQuery;
    } else {
      this.fieldQueries = this.defaultFieldQueries();
      this.legacySparqlQuery = undefined;
    }
  }

  // ─── Manifest ───────────────────────────────────────────────

  buildManifest(): Promise<ManifestType> {
    return Promise.resolve({
      versions: ["0.2"],
      name: `Reconciliation Lunr ${this.projectId}`,
      identifierSpace: `https://services.sparnatural.eu/projects/${this.projectId}`,
      schemaSpace: `https://services.sparnatural.eu/projects/${this.projectId}`,
      view: { url: "{{id}}" },
      defaultTypes: [],
      types: [],
      features: {
        "property-search": false,
        "type-search": false,
        preview: false,
        suggest: false,
      },
    });
  }

  // ─── Reconciliation ─────────────────────────────────────────

  async reconcileQueries(
    queries: ReconcileInput,
    includeTypes: boolean,
  ): Promise<ReconcileOutput> {
    await this.ensureIndex();

    const responsePayload: ReconcileOutput = {};

    // Group all keys that share the same normalized query to search once per unique term
    const keysByNorm = new Map<string, string[]>();
    for (const [key, qobj] of Object.entries(queries)) {
      const normalized = qobj.query.trim().toLowerCase();
      const existing = keysByNorm.get(normalized);
      if (existing) {
        existing.push(key);
      } else {
        keysByNorm.set(normalized, [key]);
      }
    }

    for (const [, keys] of keysByNorm) {
      const firstKey = keys[0];
      const qobj = queries[firstKey];
      const name = qobj.query.trim();
      const cacheKey = this.buildCacheKey(name, qobj.type, includeTypes);

      let results: ReconcileResult[];
      if (this.checkCache(cacheKey, includeTypes)) {
        results = this.memoryCache.get(cacheKey)!;
        // Re-insert to mark as recently used
        this.memoryCache.delete(cacheKey);
        this.memoryCache.set(cacheKey, results);
        this.logResult(name, results, "cache");
      } else {
        logger.info({}, `[lunr-recon] Reconciling: "${name}"`);
        results = this.searchIndex(name);
        this.updateCache(cacheKey, results);
        this.logResult(name, results, "lunr");
      }

      for (const key of keys) {
        responsePayload[key] = { result: results };
      }
    }

    return responsePayload;
  }

  // ─── URI resolution ─────────────────────────────────────────

  async resolveQueryUris(parsedQuery: any): Promise<any> {
    const labelsToResolve = collectUnresolvedLabels(parsedQuery);

    if (Object.keys(labelsToResolve).length === 0) {
      logger.info({}, "[lunr-recon] No URI_NOT_FOUND to resolve.");
      return parsedQuery;
    }

    logger.info(
      {},
      `[lunr-recon] Resolving ${Object.keys(labelsToResolve).length} label(s): ${Object.values(labelsToResolve).map((l: SingleReconcileQuery) => l.query).join(", ")}`,
    );

    const queries = LunrReconcileService.parseQueries(labelsToResolve);
    const uriRes = await this.reconcileQueries(queries, false);
    const labelToUri = buildLabelToUriMap(labelsToResolve, uriRes);
    injectResolvedUris(parsedQuery, labelToUri);

    return parsedQuery;
  }

  // ─── Index construction ─────────────────────────────────────

  warmUp(): Promise<void> {
    return this.ensureIndex();
  }

  private ensureIndex(): Promise<void> {
    if (this.index) return Promise.resolve();
    if (!this.indexBuilding) {
      const buildOrLoad = this.indexCachePath
        ? fs.promises
            .access(this.indexCachePath)
            .then(() => this.loadIndexFromFile(this.indexCachePath!))
            .catch(() => this.buildIndex())
        : this.buildIndex();

      this.indexBuilding = buildOrLoad.catch((err) => {
        this.indexBuilding = null;
        throw err;
      });
    }
    return this.indexBuilding;
  }

  private async loadIndexFromFile(filePath: string): Promise<void> {
    try {
      logger.info({}, `[lunr-recon] Loading index from "${filePath}"…`);
      const raw = JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
      this.index = lunr.Index.load(raw.index);

      if (raw.uriToData) {
        for (const [uri, data] of Object.entries(
          raw.uriToData as Record<string, UriData & { altLabels?: string[] }>,
        )) {
          const fields: Record<string, string[]> = data.fields ?? {};
          // Convert old { altLabels: string[] } format to fields.altLabel
          if (
            Array.isArray(data.altLabels) &&
            data.altLabels.length > 0 &&
            !fields.altLabel
          ) {
            fields.altLabel = data.altLabels;
          }
          this.uriToData.set(uri, { label: data.label ?? uri, fields });
        }
      } else if (raw.uriToLabel) {
        // Oldest cache format
        for (const [uri, label] of Object.entries(
          raw.uriToLabel as Record<string, string>,
        )) {
          this.uriToData.set(uri, { label, fields: {} });
        }
      }

      logger.info(
        {},
        `[lunr-recon] Index loaded: ${this.uriToData.size} entity(ies).`,
      );
    } catch (err) {
      logger.warn(
        {},
        "[lunr-recon] Failed to load cache file — rebuilding from SPARQL.",
      );
      throw err;
    }
  }

  private async buildIndex(): Promise<void> {
    logger.info(
      {},
      `[lunr-recon] Building lunr index for project "${this.projectId}"`,
    );

    const dataByUri = new Map<
      string,
      { displayLabel: string | null; fields: Record<string, Set<string>> }
    >();

    if (this.fieldQueries.length > 0) {
      const allBindings = await Promise.all(
        this.fieldQueries.map((fq) =>
          this.loadFieldDocuments(fq).then((bindings) => ({
            field: fq.field,
            bindings,
          })),
        ),
      );

      for (const { field, bindings } of allBindings) {
        for (const { entity, value } of bindings) {
          if (!dataByUri.has(entity))
            dataByUri.set(entity, { displayLabel: null, fields: {} });
          const entry = dataByUri.get(entity)!;
          if (!entry.fields[field]) entry.fields[field] = new Set();
          entry.fields[field].add(value);
          if (entry.displayLabel === null && field === "label")
            entry.displayLabel = value;
        }
      }
    } else {
      const rawDocs = await this.loadLegacyDocuments();
      for (const doc of rawDocs) {
        if (!dataByUri.has(doc.id))
          dataByUri.set(doc.id, { displayLabel: null, fields: {} });
        const entry = dataByUri.get(doc.id)!;
        if (doc.label) {
          if (!entry.fields.label) entry.fields.label = new Set();
          entry.fields.label.add(doc.label);
          if (entry.displayLabel === null) entry.displayLabel = doc.label;
        }
        if (doc.altLabel) {
          if (!entry.fields.altLabel) entry.fields.altLabel = new Set();
          entry.fields.altLabel.add(doc.altLabel);
        }
      }
    }

    if (dataByUri.size === 0) {
      logger.warn({}, "[lunr-recon] No documents loaded — index will be empty.");
    }

    for (const [uri, { displayLabel, fields }] of dataByUri) {
      const label =
        displayLabel ?? Object.values(fields).flatMap((s) => [...s])[0] ?? uri;
      const arrayFields: Record<string, string[]> = {};
      for (const [f, set] of Object.entries(fields)) {
        arrayFields[f] = [...set];
      }
      this.uriToData.set(uri, { label, fields: arrayFields });
    }

    const fieldBoosts = new Map<string, number>();
    const indexFields =
      this.fieldQueries.length > 0
        ? this.fieldQueries
        : [
            { field: "label", boost: 10 },
            { field: "altLabel", boost: 5 },
          ];
    for (const fq of indexFields) {
      fieldBoosts.set(
        fq.field,
        Math.max(fieldBoosts.get(fq.field) ?? 0, fq.boost ?? 1),
      );
    }

    this.index = lunr(function () {
      this.ref("id");
      this.pipeline.remove(lunr.stemmer);
      this.pipeline.remove(lunr.stopWordFilter);
      this.pipeline.add(normalizeAccents);
      this.searchPipeline.remove(lunr.stemmer);
      this.searchPipeline.add(normalizeAccents);
      for (const [field, boost] of fieldBoosts) {
        this.field(field, { boost });
      }
      for (const [uri, { fields }] of dataByUri) {
        const doc: Record<string, string> = { id: uri };
        for (const [field, values] of Object.entries(fields)) {
          if (values.size > 0) doc[field] = [...values].join(" ");
        }
        this.add(doc);
      }
    });

    logger.info(
      {},
      `[lunr-recon] Index built: ${dataByUri.size} entity(ies), fields: [${[...fieldBoosts.keys()].join(", ")}].`,
    );

    if (this.indexCachePath) {
      try {
        await fs.promises.mkdir(path.dirname(this.indexCachePath), {
          recursive: true,
        });
        await fs.promises.writeFile(
          this.indexCachePath,
          JSON.stringify({ index: this.index.toJSON(), uriToData: Object.fromEntries(this.uriToData) }),
          "utf-8",
        );
        logger.info({}, `[lunr-recon] Index saved → "${this.indexCachePath}"`);
      } catch (err) {
        logger.warn({}, "[lunr-recon] Failed to save index.");
      }
    }
  }

  private async resolveQuery(fq: FieldQueryConfig): Promise<string> {
    if (fq.query) return fq.query;
    if (fq.queryFile) return fs.promises.readFile(fq.queryFile, "utf-8");
    throw new Error(
      `[lunr-recon] FieldQueryConfig for field "${fq.field}" has neither query nor queryFile.`,
    );
  }

  private async fetchSparqlBindings(query: string): Promise<SparqlBinding[]> {
    const url = `${this.sparqlEndpoint}?query=${encodeURIComponent(query)}&format=json`;
    const response = await axios.get<{ results: { bindings: SparqlBinding[] } }>(
      url,
      { timeout: 60000, family: 4 },
    );
    return response.data.results.bindings;
  }

  private async loadFieldDocuments(fq: FieldQueryConfig): Promise<FieldBinding[]> {
    logger.info({}, `[lunr-recon] Loading field "${fq.field}"…`);
    const query = await this.resolveQuery(fq);
    const bindings = await this.fetchSparqlBindings(query);
    const docs = bindings
      .filter((b) => b.entity && b.value)
      .map((b) => ({ entity: b.entity.value, value: b.value.value }));
    logger.info({}, `[lunr-recon] "${fq.field}": ${docs.length} binding(s).`);
    return docs;
  }

  private async loadLegacyDocuments(): Promise<LegacyBinding[]> {
    logger.info({}, "[lunr-recon] Loading entities from SPARQL (legacy query)…");
    const bindings = await this.fetchSparqlBindings(this.legacySparqlQuery!);
    const labelCount = bindings.filter((b) => b.label).length;
    const altLabelCount = bindings.filter((b) => b.altLabel).length;
    logger.info(
      {},
      `[lunr-recon] ${bindings.length} bindings — ${labelCount} with label, ${altLabelCount} with altLabel.`,
    );
    return bindings.map((b) => ({
      id: b.entity.value,
      label: b.label?.value,
      altLabel: b.altLabel?.value,
    }));
  }

  // ─── Search ─────────────────────────────────────────────────

  private sanitizeLunrQuery(term: string): string {
    return term
      .replace(/[+\-~^:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private searchIndex(name: string): ReconcileResult[] {
    if (!this.index) return [];

    const sanitized = this.sanitizeLunrQuery(name);
    const { results: lunrResults, mode } = this.runLunrSearch(sanitized);

    logger.info(
      {},
      `[lunr-recon] Lunr → ${lunrResults.length} result(s) for "${name}" (${mode})`,
    );

    if (lunrResults.length === 0) return [];

    const maxScore = lunrResults[0].score;
    const isMatch = this.isConfidentMatch(lunrResults, mode);

    return lunrResults.slice(0, this.maxResults).map((r, i) => ({
      id: r.ref,
      name: this.uriToData.get(r.ref)?.label ?? r.ref,
      score: Math.round((r.score / maxScore) * 100),
      match: i === 0 && isMatch,
    }));
  }

  private runLunrSearch(sanitized: string): { results: lunr.Index.Result[]; mode: SearchMode } {
    const tokens = sanitized.split(/\s+/).filter(Boolean);

    // 1. Wildcard suffix — best for partial/autocomplete input
    try {
      const results = this.index!.search(`${sanitized}*`);
      if (results.length > 0) return { results, mode: "wildcard" };
    } catch {}

    // 2. Fuzzy ~1 per token — handles single-char typos ("aspiryne" → "aspirine")
    try {
      const results = this.index!.search(tokens.map((t) => `${t}~1`).join(" "));
      if (results.length > 0) return { results, mode: "fuzzy" };
    } catch {}

    // 3. Fuzzy ~2 for tokens ≥5 chars — handles combined typo+incomplete input
    //    ("aspiryn" → "aspirine": 2 edits: y→i + insert e)
    const haslongToken = tokens.some((t) => t.length >= 5);
    if (haslongToken) {
      try {
        const fuzzy2Query = tokens.map((t) => (t.length >= 5 ? `${t}~2` : t)).join(" ");
        const results = this.index!.search(fuzzy2Query);
        if (results.length > 0) return { results, mode: "fuzzy" };
      } catch {}
    }

    // 4. Exact — final fallback
    try {
      return { results: this.index!.search(sanitized), mode: "exact" };
    } catch {
      return { results: [], mode: "exact" };
    }
  }

  private isConfidentMatch(results: lunr.Index.Result[], mode: SearchMode): boolean {
    // Fuzzy results are inherently uncertain — never auto-accept
    if (mode === "fuzzy") return false;
    // Single result with no competition is always a confident match
    if (results.length === 1) return true;
    // Top result must be at least MATCH_MIN_GAP relatively better than the second
    const gap = (results[0].score - results[1].score) / results[0].score;
    return gap >= LunrReconcileService.MATCH_MIN_GAP;
  }

  // ─── Defaults ────────────────────────────────────────────────

  private defaultFieldQueries(): FieldQueryConfig[] {
    return [
      {
        field: "label",
        boost: 10,
        query: `
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?entity ?value WHERE {
            ?entity rdfs:label ?value .
            FILTER(LANG(?value) = "fr" || LANG(?value) = "")
          }
        `,
      },
    ];
  }

  // ─── Cache ───────────────────────────────────────────────────

  private buildCacheKey(
    name: string,
    type?: string,
    includeTypes?: boolean,
  ): string {
    return encodeURIComponent(
      name.toLowerCase() +
        (type ? `|${type}` : "") +
        (includeTypes ? "|openrefine" : "|simple"),
    );
  }

  private checkCache(cacheKey: string, includeTypes: boolean): boolean {
    const results = this.memoryCache.get(cacheKey);
    if (!results) return false;
    if (includeTypes && !results[0]?.type) return false;
    return true;
  }

  private updateCache(key: string, results: ReconcileResult[]): void {
    this.memoryCache.delete(key);
    this.memoryCache.set(key, results);
    if (this.memoryCache.size > this.cacheSize) {
      const oldestKey = this.memoryCache.keys().next().value!;
      this.memoryCache.delete(oldestKey);
      logger.info({}, `[cache] LRU eviction: "${oldestKey}"`);
    }
  }

  // ─── Utils ───────────────────────────────────────────────────

  private logResult(
    name: string,
    results: ReconcileResult[],
    source: string,
  ): void {
    logger.info(
      {},
      results.length > 0
        ? `[lunr-recon] "${name}" → "${results[0].id}" label:"${results[0].name}" (${source})`
        : `[lunr-recon] "${name}" → no results (${source})`,
    );
  }

  static parseQueries(body: unknown): ReconcileInput {
    if (!body) throw new Error("Empty body");
    const b = body as Record<string, unknown>;
    if (b.queries) {
      return typeof b.queries === "string"
        ? JSON.parse(b.queries)
        : (b.queries as ReconcileInput);
    }
    if (typeof body === "object" && !Array.isArray(body)) {
      return body as ReconcileInput;
    }
    throw new Error("Invalid queries format");
  }
}
