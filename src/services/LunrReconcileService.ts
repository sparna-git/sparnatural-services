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
} from "./ReconcileServiceIfc";
import { inject, injectable } from "tsyringe";
import { LunrReconcileServiceConfig } from "../config/ProjectConfig";
import {
  collectUnresolvedLabels,
  buildLabelToUriMap,
  injectResolvedUris,
} from "../utils/UriReconciliationHelperV13";

type CacheEntry = { results: ReconcileResult[]; lastAccessed: Date };

/** One document in the lunr index */
type IndexDoc = { id: string; label: string };

@injectable({ token: "LunrReconcileService" })
export class LunrReconcileService implements ReconcileServiceIfc {
  public static DEFAULT_MAX_RESULTS = 10;
  public static DEFAULT_CACHE_SIZE = 1000;
  public static DEFAULT_SIMILARITY_THRESHOLD = 0.9;

  private memoryCache: Record<string, CacheEntry> = {};
  private projectId: string;
  private sparqlEndpoint: string;
  private maxResults: number;
  private cacheSize: number;
  private similarityThreshold: number | undefined;
  private sparqlQuery: string;
  private indexCachePath: string | undefined;

  /** lunr index built lazily on first search */
  private index: lunr.Index | null = null;
  /** Maps entity URI → label, used to retrieve the label after a lunr search */
  private uriToLabel: Map<string, string> = new Map();
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
    this.similarityThreshold =
      reconciliationConfig?.similarityThreshold ??
      LunrReconcileService.DEFAULT_SIMILARITY_THRESHOLD;
    this.sparqlQuery =
      reconciliationConfig?.sparqlQuery ?? this.defaultSparqlQuery();
    this.indexCachePath = reconciliationConfig?.indexCachePath;
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

  // ─── Reconciliation principale ──────────────────────────────

  async reconcileQueries(
    queries: ReconcileInput,
    includeTypes: boolean,
  ): Promise<ReconcileOutput> {
    await this.ensureIndex();

    const responsePayload: ReconcileOutput = {};

    const uniqueMap = new Map<string, [string, any]>();
    for (const [key, qobj] of Object.entries(queries)) {
      const normalized = qobj.query.trim().toLowerCase();
      if (!uniqueMap.has(normalized)) {
        uniqueMap.set(normalized, [key, qobj]);
      }
    }

    for (const [key, qobj] of uniqueMap.values()) {
      const name = qobj.query.trim();
      const cacheKey = this.buildCacheKey(name, qobj.type, includeTypes);

      if (this.checkCache(cacheKey, includeTypes)) {
        this.memoryCache[cacheKey].lastAccessed = new Date();
        responsePayload[key] = { result: this.memoryCache[cacheKey].results };
        this.logResult(name, this.memoryCache[cacheKey].results, "cache");
        continue;
      }

      console.log(`\n[lunr-recon] ═══ Réconciliation : "${name}" ═══`);

      const results = this.searchIndex(name);
      this.updateCache(cacheKey, results);
      responsePayload[key] = { result: results };
      this.logResult(name, results, "lunr");
    }

    return responsePayload;
  }

  // ─── Résolution des URI_NOT_FOUND ──────────────────────────

  async resolveQueryUris(parsedQuery: any): Promise<any> {
    const labelsToResolve = collectUnresolvedLabels(parsedQuery);

    if (Object.keys(labelsToResolve).length === 0) {
      console.log("[lunr-recon] No URI_NOT_FOUND to resolve.");
      return parsedQuery;
    }

    console.log(
      `[lunr-recon] Resolving ${Object.keys(labelsToResolve).length} label(s):`,
      Object.values(labelsToResolve).map((l) => l.query),
    );

    const queries = LunrReconcileService.parseQueries(labelsToResolve);
    const uriRes = await this.reconcileQueries(queries, false);
    const labelToUri = buildLabelToUriMap(labelsToResolve, uriRes);
    injectResolvedUris(parsedQuery, labelToUri);

    return parsedQuery;
  }

  // ─── Index construction ─────────────────────────────────────

  /**
   * Ensures the lunr index is built exactly once, even under concurrent requests.
   */
  private ensureIndex(): Promise<void> {
    if (this.index) return Promise.resolve();
    if (!this.indexBuilding) {
      const loader =
        this.indexCachePath && fs.existsSync(this.indexCachePath)
          ? this.loadIndexFromFile(this.indexCachePath)
          : this.buildIndex();
      this.indexBuilding = loader.catch((err) => {
        this.indexBuilding = null;
        throw err;
      });
    }
    return this.indexBuilding;
  }

  private loadIndexFromFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log(`[lunr-recon] Chargement de l'index depuis "${filePath}"…`);
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        this.index = lunr.Index.load(raw.index);
        this.uriToLabel = new Map(Object.entries(raw.uriToLabel));
        console.log(
          `[lunr-recon] Index chargé : ${this.uriToLabel.size} entité(s).`,
        );
        resolve();
      } catch (err) {
        console.warn(
          `[lunr-recon] Échec du chargement du fichier cache — reconstruction depuis SPARQL.`,
          err,
        );
        reject(err);
      }
    });
  }

  private async buildIndex(): Promise<void> {
    console.log(
      `[lunr-recon] Building lunr index for project "${this.projectId}"`,
    );

    const rawDocs = await this.loadDocuments();

    if (rawDocs.length === 0) {
      console.warn("[lunr-recon] No documents loaded — index will be empty.");
    }

    // Un même URI peut avoir plusieurs labels (synonymes, ATC plain + CONCAT, etc.).
    // On groupe par URI et on fusionne tous les labels dans un seul document lunr :
    //  - uriToLabel garde le premier label comme label d'affichage
    //  - le champ lunr "label" contient tous les labels concaténés → tous cherchables
    const labelsByUri = new Map<string, string[]>();
    for (const doc of rawDocs) {
      if (!labelsByUri.has(doc.id)) labelsByUri.set(doc.id, []);
      labelsByUri.get(doc.id)!.push(doc.label);
    }

    for (const [uri, labels] of labelsByUri) {
      this.uriToLabel.set(uri, labels[0]);
    }

    this.index = lunr(function () {
      this.field("label");
      this.ref("id");
      // disable stemming so that French terms are not mangled
      this.pipeline.remove(lunr.stemmer);
      this.searchPipeline.remove(lunr.stemmer);
      for (const [uri, labels] of labelsByUri) {
        this.add({ id: uri, label: labels.join(" ") });
      }
    });

    console.log(
      `[lunr-recon] Index: ${labelsByUri.size} entité(s) (${rawDocs.length} labels au total).`,
    );

    if (this.indexCachePath) {
      try {
        const dir = path.dirname(this.indexCachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const payload = {
          index: this.index.toJSON(),
          uriToLabel: Object.fromEntries(this.uriToLabel),
        };
        fs.writeFileSync(this.indexCachePath, JSON.stringify(payload), "utf-8");
        console.log(`[lunr-recon] Index sauvegardé → "${this.indexCachePath}"`);
      } catch (err) {
        console.warn(`[lunr-recon] Impossible de sauvegarder l'index.`, err);
      }
    }
  }

  private async loadDocuments(): Promise<IndexDoc[]> {
    const url = `${this.sparqlEndpoint}?query=${encodeURIComponent(this.sparqlQuery)}&format=json`;
    console.log(`[lunr-recon] Loading entities from SPARQL endpoint…`);

    const response = await axios.get(url, { timeout: 60000, family: 4 });
    const bindings: any[] = response.data.results.bindings;
    // log 20 first results for debugging
    console.log(
      `[lunr-recon] ${bindings.length} entities loaded. Sample:`,
      bindings
        .slice(0, 20)
        .map((b) => ({ id: b.entity.value, label: b.label?.value })),
    );

    // A single entity may have multiple labels — keep one doc per (uri, label) pair
    return bindings.map((b: any) => ({
      id: b.entity.value,
      label: b.label?.value ?? "",
    }));
  }

  // ─── Recherche ──────────────────────────────────────────────

  /**
   * Neutralise les opérateurs lunr dans le terme de recherche.
   * Le `-` (NOT), `+` (boost), `~` (fuzzy), `^` (boost), `:` (champ) sont des opérateurs
   * qui faussent la recherche si le label de l'entité les contient (ex: "A07AA11 - rifaximine").
   */
  /**
   * Neutralise les opérateurs lunr ET met en minuscules.
   * Les termes avec wildcard (*) court-circuitent le pipeline lunr (pas de toLowerCase automatique).
   * Les tokens indexés étant tous en minuscules, la query doit l'être aussi.
   */
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
    let lunrResults: lunr.Index.Result[] = [];

    try {
      // Wildcard suffix search for partial matches
      lunrResults = this.index.search(`${sanitized}*`);
    } catch {
      // lunr throws on some query strings (e.g. only stop words) — fall back without wildcard
      try {
        lunrResults = this.index.search(sanitized);
      } catch {
        return [];
      }
    }

    console.log(
      `[lunr-recon] Lunr → ${lunrResults.length} résultat(s) pour "${name}"`,
    );

    const topN = lunrResults.slice(0, this.maxResults);

    if (this.similarityThreshold !== undefined) {
      const threshold = this.similarityThreshold;
      const withSim = topN.map((r) => ({
        uri: r.ref,
        label: this.uriToLabel.get(r.ref) ?? r.ref,
        similarity: this.stringSimilarity(
          name,
          this.uriToLabel.get(r.ref) ?? "",
        ),
      }));

      const best =
        withSim.length > 0
          ? withSim.reduce((a, b) => (b.similarity > a.similarity ? b : a))
          : null;

      if (best && best.similarity >= threshold) {
        const reranked = [...withSim].sort(
          (a, b) => b.similarity - a.similarity,
        );
        console.log(
          `[lunr-recon] Similarity rerank (threshold: ${threshold}) — best: "${best.label}" ${(best.similarity * 100).toFixed(1)}%`,
        );
        return reranked.map((r, i) => ({
          id: r.uri,
          name: r.label,
          score: i === 0 ? 100 : Math.max(100 - i, 1),
          match: i === 0,
        }));
      }

      console.log(
        `[lunr-recon] No result above similarity threshold (${threshold})`,
      );
    }

    return topN.map((r, i) => ({
      id: r.ref,
      name: this.uriToLabel.get(r.ref) ?? r.ref,
      score: i === 0 ? 100 : Math.max(100 - i, 1),
      match: i === 0,
    }));
  }

  // ─── SPARQL par défaut ───────────────────────────────────────

  private defaultSparqlQuery(): string {
    return `
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?entity ?label WHERE {
        ?entity rdfs:label ?label .
        FILTER(LANG(?label) = "fr" || LANG(?label) = "")
      }
    `;
  }

  // ─── Similarity ──────────────────────────────────────────────

  private stringSimilarity(a: string, b: string): number {
    const s1 = a.toLowerCase().trim();
    const s2 = b.toLowerCase().trim();
    if (s1 === s2) return 1;
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1;
    return 1 - this.levenshtein(s1, s2) / maxLen;
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = dp[j];
        dp[j] =
          a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = temp;
      }
    }
    return dp[n];
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
    const entry = this.memoryCache[cacheKey];
    if (!entry) return false;
    if (includeTypes && !entry.results[0]?.type) return false;
    return true;
  }

  updateCache(key: string, results: ReconcileResult[]) {
    this.memoryCache[key] = { results, lastAccessed: new Date() };
    const keys = Object.keys(this.memoryCache);
    if (keys.length > this.cacheSize) {
      const oldestKey = keys.reduce((a, b) =>
        this.memoryCache[a].lastAccessed < this.memoryCache[b].lastAccessed
          ? a
          : b,
      );
      delete this.memoryCache[oldestKey];
      console.log(`[cache] LRU: suppression "${oldestKey}"`);
    }
  }

  // ─── Utils ───────────────────────────────────────────────────

  private logResult(
    name: string,
    results: ReconcileResult[],
    source: string,
  ): void {
    console.log(
      results.length > 0
        ? `[lunr-recon] "${name}" → "${results[0].id}" label:"${results[0].name}" (${source})`
        : `[lunr-recon] "${name}" → aucun résultat (${source})`,
    );
  }

  static parseQueries(body: any): ReconcileInput {
    if (!body) throw new Error("Empty body");
    if (body.queries) {
      return typeof body.queries === "string"
        ? JSON.parse(body.queries)
        : body.queries;
    }
    if (typeof body === "object" && !Array.isArray(body)) {
      return body;
    }
    throw new Error("Invalid queries format");
  }
}
