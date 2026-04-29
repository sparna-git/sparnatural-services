import axios from "axios";
import {
  ReconcileOutput,
  ReconcileServiceIfc,
  ReconcileInput,
  ReconcileResult,
  ManifestType,
} from "./ReconcileServiceIfc";
import { inject, injectable } from "tsyringe";
import { LuceneReconcileServiceConfig } from "../config/ProjectConfig";
import {
  collectUnresolvedLabels,
  buildLabelToUriMap,
  injectResolvedUris,
} from "../utils/UriReconciliationHelperV13";
import { getSHACLConfig } from "../config/SCHACL";

type CacheEntry = { results: ReconcileResult[]; lastAccessed: Date };
type SearchResult = { uri: string; label: string };

/**
 * Service de réconciliation basé sur le connecteur Lucene de GraphDB.
 *
 * Stratégie :
 * 1. Recherche Lucene dans l'index configuré (types indexés : SpecialitePharmaceutique,
 *    Substance, Presentation, UCD, Evenement, GroupeGenerique).
 * 2. Si aucun résultat Lucene (ex. Voie non indexé), fallback SPARQL par rdfs:label CONTAINS
 *    avec le rdfType Sparnatural dans "?uri a <configTypeUri>" + expandSparql (comme SparqlReconcileServiceV13).
 * 3. Si SHACL indisponible ou toujours rien, recherche SPARQL sans filtre de type.
 *
 * Le label réel du graphe ("intraveineuse (2225)") est retourné, pas juste le terme de recherche.
 */
@injectable({ token: "LuceneReconcileService" })
export class LuceneReconcileService implements ReconcileServiceIfc {
  public static DEFAULT_MAX_RESULTS = 10;
  public static DEFAULT_CACHE_SIZE = 1000;
  public static DEFAULT_INDEX_NAME = "MedicamentIndexThird";
  public static DEFAULT_SIMILARITY_THRESHOLD = 0.9;

  private memoryCache: Record<string, CacheEntry> = {};
  private projectId: string;
  private sparqlEndpoint: string;
  private maxResults: number;
  private cacheSize: number;
  private luceneIndexName: string;
  private similarityThreshold: number | undefined;

  constructor(
    @inject("project.id") projectId?: string,
    @inject("project.sparqlEndpoint") sparqlEndpoint?: string,
    @inject("reconciliation.config")
    reconciliationConfig?: LuceneReconcileServiceConfig,
  ) {
    this.projectId = projectId || "";
    this.sparqlEndpoint = sparqlEndpoint || "";
    this.maxResults =
      reconciliationConfig?.maxResults ||
      LuceneReconcileService.DEFAULT_MAX_RESULTS;
    this.cacheSize =
      reconciliationConfig?.cacheSize ||
      LuceneReconcileService.DEFAULT_CACHE_SIZE;
    this.luceneIndexName =
      reconciliationConfig?.luceneIndexName ||
      LuceneReconcileService.DEFAULT_INDEX_NAME;
    this.similarityThreshold =
      reconciliationConfig?.similarityThreshold ||
      LuceneReconcileService.DEFAULT_SIMILARITY_THRESHOLD;
  }

  // ─── Manifest ───────────────────────────────────────────────

  buildManifest(): Promise<ManifestType> {
    return Promise.resolve({
      versions: ["0.2"],
      name: `Reconciliation Lucene ${this.projectId}`,
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
    const responsePayload: ReconcileOutput = {};

    // Dédupliquer par label normalisé
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

      // Le rdfType Sparnatural (type config, ex: "https://.../sparnatural-config.ttl#Voie")
      const configTypeUri = qobj.type as string | undefined;

      console.log(
        `\n[lucene-recon] ═══ Réconciliation : "${name}" | type: ${configTypeUri ?? "aucun"} ═══`,
      );
      console.log(
        `[lucene-recon] 🔍 Recherche Lucene (index: ${this.luceneIndexName})`,
      );

      const searchResults: SearchResult[] = await this.searchLucene(
        name,
        configTypeUri,
      );
      const source = "lucene";

      console.log(
        `[lucene-recon] Lucene → ${searchResults.length} résultat(s) :`,
        searchResults.map((r) => `"${r.label}" (${r.uri.split("/").pop()})`),
      );

      const results = this.formatResults(searchResults, name);
      this.updateCache(cacheKey, results);
      responsePayload[key] = { result: results };
      this.logResult(name, results, source);
    }

    return responsePayload;
  }

  // ─── Résolution des URI_NOT_FOUND ──────────────────────────

  async resolveQueryUris(parsedQuery: any): Promise<any> {
    const labelsToResolve = collectUnresolvedLabels(parsedQuery);

    if (Object.keys(labelsToResolve).length === 0) {
      console.log("[lucene-recon] ✅ No URI_NOT_FOUND to resolve.");
      return parsedQuery;
    }

    console.log(
      `[lucene-recon] 🔎 Resolving ${Object.keys(labelsToResolve).length} label(s):`,
      Object.values(labelsToResolve).map((l) => l.query),
    );

    const queries = LuceneReconcileService.parseQueries(labelsToResolve);
    const uriRes = await this.reconcileQueries(queries, false);
    const labelToUri = buildLabelToUriMap(labelsToResolve, uriRes);
    injectResolvedUris(parsedQuery, labelToUri);

    return parsedQuery;
  }

  // ─── Étape 1 : Recherche Lucene ─────────────────────────────

  /**
   * Recherche dans l'index Lucene avec traversée de prédicats.
   *
   * Quand configTypeUri est fourni, la requête utilise un UNION pour :
   *   1. Retourner directement le résultat Lucene s'il est du bon type
   *      (?luceneResult a <configTypeUri>)
   *   2. OU traverser un niveau de prédicats pour trouver une entité liée
   *      du bon type (?luceneResult ?p ?entity . ?entity a <configTypeUri>)
   *      → ex. SpecialitePharmaceutique → med:voie → Voie
   *
   * expandSparql traduit le type config Sparnatural → type réel dans les données.
   * Si le type n'est pas dans l'index ET sans entités liées → retourne [] → fallback SPARQL.
   */
  private async searchLucene(
    name: string,
    configTypeUri?: string,
  ): Promise<SearchResult[]> {
    const escapedName = name.replace(/"/g, '\\"');
    const escapedRegex = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let sparql: string;

    if (configTypeUri) {
      sparql = `
        PREFIX : <http://www.ontotext.com/connectors/lucene#>
        PREFIX inst: <http://www.ontotext.com/connectors/lucene/instance#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

        SELECT ?entity (SAMPLE(?lbl) AS ?label) WHERE {
            ?search a inst:${this.luceneIndexName} .
            ?search :query "${escapedName}" .
            ?search :entities ?luceneResult .
            {
                ?luceneResult a <${configTypeUri}> .
                BIND(?luceneResult AS ?entity)
            } UNION {
                ?luceneResult ?p ?entity .
                ?entity a <${configTypeUri}> .
            }
            ?entity rdfs:label ?lbl .
            FILTER(LANG(?lbl) = "fr" || LANG(?lbl) = "")
        }
        GROUP BY ?entity
        LIMIT ${this.maxResults}
      `;

      // expandSparql traduit "?entity a <configTypeUri>" → "?entity a <dataTypeUri>"
      try {
        const { postProcessor } = await getSHACLConfig(this.projectId);
        sparql = postProcessor.expandSparql(sparql, {});
        console.log(`[lucene-recon] 📐 Lucene SPARQL après expand:\n${sparql}`);
      } catch (_err) {
        console.log(
          `[lucene-recon] ℹ️  SHACL non configuré → requête Lucene avec configTypeUri tel quel`,
        );
        console.log(
          `[lucene-recon] 📄 Lucene SPARQL (sans expand):\n${sparql}`,
        );
      }
    } else {
      // Sans type : requête Lucene simple
      console.log(
        `[lucene-recon] ℹ️  Aucun type fourni → requête Lucene sans filtre de type`,
      );
      sparql = `
        PREFIX : <http://www.ontotext.com/connectors/lucene#>
        PREFIX inst: <http://www.ontotext.com/connectors/lucene/instance#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

        SELECT ?entity (SAMPLE(?lbl) AS ?label) WHERE {
            ?search a inst:${this.luceneIndexName} .
            ?search :query "${escapedName}" .
            ?search :entities ?entity .
            ?entity rdfs:label ?lbl .
            FILTER(LANG(?lbl) = "fr" || LANG(?lbl) = "")
            FILTER(REGEX(STR(?lbl), "${escapedRegex}", "i"))
        }
        GROUP BY ?entity
        LIMIT ${this.maxResults}
      `;
      console.log(`[lucene-recon] 📄 Lucene SPARQL (sans type):\n${sparql}`);
    }

    try {
      const response = await axios.get(
        `${this.sparqlEndpoint}?query=${encodeURIComponent(sparql)}&format=json`,
        { timeout: 60000, family: 4 },
      );
      return response.data.results.bindings.map((b: any) => ({
        uri: b.entity.value,
        label: b.label?.value || name,
      }));
    } catch (err) {
      console.error(`[lucene-recon] ❌ Lucene error for "${name}":`, err);
      return [];
    }
  }

  // ─── Formatage des résultats ────────────────────────────────

  formatResults(
    searchResults: SearchResult[],
    fallbackName: string,
  ): ReconcileResult[] {
    if (searchResults.length === 0) return [];

    if (this.similarityThreshold !== undefined) {
      const threshold = this.similarityThreshold;
      const withSim = searchResults.map((r) => ({
        ...r,
        similarity: this.stringSimilarity(
          fallbackName,
          r.label || fallbackName,
        ),
      }));

      const best = withSim.reduce((a, b) =>
        b.similarity > a.similarity ? b : a,
      );

      if (best.similarity >= threshold) {
        const reranked = [...withSim].sort(
          (a, b) => b.similarity - a.similarity,
        );
        console.log(
          `[lucene-recon] 🎯 Similarity rerank (threshold: ${threshold}) — best: "${best.label}" ${(best.similarity * 100).toFixed(1)}%`,
        );
        return reranked.map((r, index) => ({
          id: r.uri,
          name: r.label || fallbackName,
          score: index === 0 ? 100 : Math.max(100 - index, 1),
          match: index === 0,
        }));
      }

      console.log(
        `[lucene-recon] ℹ️  No result above similarity threshold (${threshold}) — keeping Lucene order`,
      );
    }

    return searchResults.map((r, index) => ({
      id: r.uri,
      name: r.label || fallbackName,
      score: index === 0 ? 100 : Math.max(100 - index, 1),
      match: index === 0,
    }));
  }

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

  // ─── Cache ──────────────────────────────────────────────────

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
      console.log(`[cache] 🧹 LRU: suppression "${oldestKey}"`);
    }
  }

  // ─── Utils ──────────────────────────────────────────────────

  private logResult(
    name: string,
    results: ReconcileResult[],
    source: string,
  ): void {
    console.log(
      results.length > 0
        ? `[lucene-recon] 🔎 "${name}" → "${results[0].id}" label:"${results[0].name}" (${source})`
        : `[lucene-recon] 🔎 "${name}" → aucun résultat (${source})`,
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
