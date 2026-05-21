import "reflect-metadata";
import "./lunrPipeline"; // must be imported before any index build or load
import { inject, injectable } from "tsyringe";
import {
  ReconcileOutput,
  ReconcileServiceIfc,
  ReconcileInput,
  ReconcileResult,
  ManifestType,
  SingleReconcileQuery,
} from "../../interfaces/ReconcileServiceIfc";
import {
  FieldQueryConfig,
  LunrReconcileServiceConfig,
  ProjectConfig,
} from "../../../../config/ProjectConfig";
import {
  collectUnresolvedLabels,
  buildLabelToUriMap,
  injectResolvedUris,
} from "../../helpers/UriReconciliationHelperV13";
import logger from "../../../../utils/logger";
import { UriData } from "./types";
import { ReconcileCache } from "./ReconcileCache";
import { LunrIndexBuilder } from "./LunrIndexBuilder";
import { LunrIndexStore } from "./LunrIndexStore";
import { LunrSearchEngine } from "./LunrSearchEngine";

@injectable({ token: "LunrReconcileService" })
export class LunrReconcileService implements ReconcileServiceIfc {
  public static DEFAULT_MAX_RESULTS = 10;
  public static DEFAULT_CACHE_SIZE = 1000;

  private readonly projectId: string;
  private readonly maxResults: number;
  private readonly initialShaclTypes: string[];
  private readonly fieldBoosts: Map<string, number>;
  private readonly builder: LunrIndexBuilder;
  private readonly store: LunrIndexStore | null;
  private readonly cache: ReconcileCache;

  private engine: LunrSearchEngine | null = null;
  private indexBuilding: Promise<void> | null = null;

  constructor(
    @inject("project.id") projectId?: string,
    @inject("project.sparqlEndpoint") sparqlEndpoint?: string,
    @inject("reconciliation.config")
    reconciliationConfig?: LunrReconcileServiceConfig,
    @inject("project.config") projectConfig?: ProjectConfig,
  ) {
    this.projectId = projectId || "";
    this.maxResults =
      reconciliationConfig?.maxResults ??
      LunrReconcileService.DEFAULT_MAX_RESULTS;
    this.initialShaclTypes = projectConfig?.shaclTypes ?? [];

    let fieldQueries: FieldQueryConfig[];
    let legacySparqlQuery: string | undefined;
    if (reconciliationConfig?.sparqlQueries?.length) {
      fieldQueries = reconciliationConfig.sparqlQueries;
      legacySparqlQuery = undefined;
    } else if (reconciliationConfig?.sparqlQuery) {
      fieldQueries = [];
      legacySparqlQuery = reconciliationConfig.sparqlQuery;
    } else {
      fieldQueries = this.defaultFieldQueries();
      legacySparqlQuery = undefined;
    }

    this.fieldBoosts = this.computeFieldBoosts(fieldQueries);
    this.builder = new LunrIndexBuilder(
      this.projectId,
      sparqlEndpoint || "",
      fieldQueries,
      legacySparqlQuery,
      this.fieldBoosts,
    );
    this.store = reconciliationConfig?.indexCachePath
      ? new LunrIndexStore(reconciliationConfig.indexCachePath)
      : null;
    this.cache = new ReconcileCache(
      reconciliationConfig?.cacheSize ??
        LunrReconcileService.DEFAULT_CACHE_SIZE,
    );
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

    // Group keys sharing the same normalized query to search once per unique term
    const keysByNorm = new Map<string, string[]>();
    for (const [key, qobj] of Object.entries(queries)) {
      const normalized = qobj.query.trim().toLowerCase();
      const existing = keysByNorm.get(normalized);
      if (existing) existing.push(key);
      else keysByNorm.set(normalized, [key]);
    }

    for (const [, keys] of keysByNorm) {
      const firstKey = keys[0];
      const qobj = queries[firstKey];
      const name = qobj.query.trim();
      const cacheKey = this.cache.buildKey(name, qobj.type, includeTypes);

      let results: ReconcileResult[];
      const cached = this.cache.get(cacheKey, includeTypes);
      if (cached) {
        results = cached;
        this.logResult(name, results, "cache");
      } else {
        logger.info({}, `[lunr-recon] Reconciling: "${name}"`);
        results = this.engine!.search(name, qobj.type);
        this.cache.set(cacheKey, results);
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
      `[lunr-recon] Resolving ${Object.keys(labelsToResolve).length} label(s): ${Object.values(
        labelsToResolve,
      )
        .map((l: SingleReconcileQuery) => l.query)
        .join(", ")}`,
    );

    const queries = LunrReconcileService.parseQueries(labelsToResolve);
    const uriRes = await this.reconcileQueries(queries, false);
    const labelToUri = buildLabelToUriMap(labelsToResolve, uriRes);
    injectResolvedUris(parsedQuery, labelToUri);

    return parsedQuery;
  }

  // ─── Index lifecycle ─────────────────────────────────────────

  warmUp(): Promise<void> {
    return this.ensureIndex();
  }

  private ensureIndex(): Promise<void> {
    if (this.engine) return Promise.resolve();
    if (!this.indexBuilding) {
      this.indexBuilding = this.buildEngine().catch((err) => {
        this.indexBuilding = null;
        throw err;
      });
    }
    return this.indexBuilding;
  }

  private async buildEngine(): Promise<void> {
    const shaclTypes = await this.builder.resolveShaclTypes(
      this.initialShaclTypes,
    );

    let index: import("lunr").Index;
    let uriToData: Map<string, UriData>;

    if (this.store && (await this.store.exists())) {
      const loaded = await this.store.load();
      if (loaded) {
        ({ index, uriToData } = loaded);
        if (shaclTypes.length > 0) {
          const hasTypes = [...uriToData.values()].some(
            (d) => d.types && d.types.length > 0,
          );
          if (!hasTypes) {
            logger.info(
              {},
              `[lunr-recon] Type data missing from cache — loading from SPARQL.`,
            );
            await this.builder.loadTypesFromSparql(uriToData, shaclTypes);
          }
        }
      } else {
        ({ index, uriToData } = await this.builder.build(shaclTypes));
        await this.store.save(index, uriToData);
      }
    } else {
      ({ index, uriToData } = await this.builder.build(shaclTypes));
      if (this.store) await this.store.save(index, uriToData);
    }

    this.engine = new LunrSearchEngine(
      index,
      uriToData,
      this.fieldBoosts,
      this.maxResults,
    );
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

  private computeFieldBoosts(
    fieldQueries: FieldQueryConfig[],
  ): Map<string, number> {
    const boosts = new Map<string, number>();
    const source =
      fieldQueries.length > 0
        ? fieldQueries
        : [
            { field: "label", boost: 10 },
            { field: "altLabel", boost: 5 },
          ];
    for (const fq of source)
      boosts.set(fq.field, Math.max(boosts.get(fq.field) ?? 0, fq.boost ?? 1));
    return boosts;
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
