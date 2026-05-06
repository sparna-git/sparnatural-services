import axios from "axios";
import { getSHACLConfig } from "../config/SCHACL";
import {
  ReconcileOutput,
  ReconcileServiceIfc,
  ReconcileInput,
  ReconcileResult,
  ManifestType,
} from "./ReconcileServiceIfc";
import { inject, injectable } from "tsyringe";
import { SparqlReconcileServiceConfig } from "../config/ProjectConfig";
import {
  collectUnresolvedLabels,
  buildLabelToUriMap,
  injectResolvedUris,
} from "../utils/UriReconciliationHelperOld";

type CacheEntry = { results: ReconcileResult[]; lastAccessed: Date };

@injectable({ token: "SparqlReconcileService" })
// this indicates it is the default implementation for this service
@injectable({ token: "default:reconciliation" })
export class SparqlReconcileService implements ReconcileServiceIfc {
  public static DEFAULT_MAX_RESULTS = 10;
  public static DEFAULT_CACHE_SIZE = 1000;

  // --- Cache mémoire par projet ---
  private memoryCache: Record<string, CacheEntry> = {};

  private projectId: string;
  private sparqlEndpoint: string;

  private maxResults: number;
  private cacheSize: number;

  constructor(
    @inject("project.id") projectId?: string,
    @inject("project.sparqlEndpoint") sparqlEndpoint?: string,
    @inject("reconciliation.config")
    reconciliationConfig?: SparqlReconcileServiceConfig,
  ) {
    this.projectId = projectId || "";
    this.sparqlEndpoint = sparqlEndpoint || "";

    this.maxResults =
      reconciliationConfig?.maxResults ||
      SparqlReconcileService.DEFAULT_MAX_RESULTS;
    this.cacheSize =
      reconciliationConfig?.cacheSize ||
      SparqlReconcileService.DEFAULT_CACHE_SIZE;
  }

  // --- Manifest ---
  buildManifest(): Promise<ManifestType> {
    return Promise.resolve({
      versions: ["0.2"],
      name: `Reconciliation ${this.projectId}`,
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

  // --- Reconciliation ---
  reconcileQueries(
    queries: ReconcileInput,
    includeTypes: boolean,
  ): Promise<ReconcileOutput> {
    const uriCache = this.memoryCache;
    const responsePayload: ReconcileOutput = {};

    // Convertir en tableau : [key, qobj]
    let entries = Object.entries(queries);

    // SUPPRESSION DES DOUBLONS if exist
    // On garde la première clé rencontrée
    const uniqueMap = new Map<string, [string, any]>();
    for (const [key, qobj] of entries) {
      const normalized = qobj.query.trim().toLowerCase();
      if (!uniqueMap.has(normalized)) {
        uniqueMap.set(normalized, [key, qobj]);
      }
    }

    const uniqueEntries = Array.from(uniqueMap.values());

    // Exécution séquentielle
    let chain = Promise.resolve();

    uniqueEntries.forEach(([key, qobj]) => {
      chain = chain.then(() => {
        const name = qobj.query.trim();
        console.log("[QOBJ]", qobj);
        const cacheKey = encodeURIComponent(
          name.toLowerCase() +
            (qobj.type ? `|${qobj.type}` : "") +
            (includeTypes ? "|openrefine" : "|simple"),
        );
        console.log("[cacheKey]", cacheKey);

        // Résultat déjà en cache ?
        if (
          uriCache[cacheKey] &&
          (!includeTypes || uriCache[cacheKey].results[0]?.type)
        ) {
          uriCache[cacheKey].lastAccessed = new Date();
          responsePayload[key] = { result: uriCache[cacheKey].results };

          console.log(
            uriCache[cacheKey].results.length > 0
              ? `[reconciliation] 🔎 "${name}" → "${uriCache[cacheKey].results[0].id}"`
              : `[reconciliation] 🔎 "${name}" → aucun résultat`,
          );

          return;
        }

        // Sinon → SPARQL + cache
        return this.runSparqlSearch(name, qobj.type, includeTypes).then(
          (uris) => {
            if (includeTypes) {
              return this.formatResultsWithTypes(uris, name).then((results) => {
                this.updateCache(cacheKey, results);
                responsePayload[key] = { result: results };
                console.log(
                  results.length > 0
                    ? `[reconciliation] 🔎 "${name}" → "${results[0].id}"`
                    : `[reconciliation] 🔎 "${name}" → aucun résultat`,
                );
              });
            } else {
              const results = this.formatResults(uris, name);
              this.updateCache(cacheKey, results);
              responsePayload[key] = { result: results };
              console.log(
                results.length > 0
                  ? `[reconciliation] 🔎 "${name}" → "${results[0].id}"`
                  : `[reconciliation] 🔎 "${name}" → aucun résultat`,
              );
            }
          },
        );
      });
    });

    return chain.then(() => responsePayload);
  }

  /**
   * Takes a complete parsed SparnaturalQuery (old structure: branches → line.criterias → criteria.rdfTerm),
   * finds all URI_NOT_FOUND labels, reconciles them via SPARQL, and injects the resolved URIs back.
   */
  async resolveQueryUris(parsedQuery: any): Promise<any> {
    const labelsToResolve = collectUnresolvedLabels(parsedQuery);

    if (Object.keys(labelsToResolve).length === 0) {
      console.log("[reconciliation] ✅ No URI_NOT_FOUND labels to resolve.");
      return parsedQuery;
    }

    console.log(
      `[reconciliation] 🔎 Resolving ${
        Object.keys(labelsToResolve).length
      } label(s):`,
      Object.values(labelsToResolve).map((l: any) => l.query),
    );

    const queries = SparqlReconcileService.parseQueries(labelsToResolve);
    const uriRes = await this.reconcileQueries(queries, false);
    const labelToUri = buildLabelToUriMap(labelsToResolve, uriRes);
    injectResolvedUris(parsedQuery, labelToUri);

    return parsedQuery;
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

  formatResults(uriList: string[], name: string) {
    const sortedUris = [...uriList].sort((a, b) => a.length - b.length);

    return sortedUris.map((uri, index) => ({
      id: uri,
      name,
      score: index === 0 ? 100 : 99,
      match: true,
    }));
  }

  formatResultsWithTypes(uriList: string[], name: string) {
    const sortedUris = [...uriList].sort((a, b) => a.length - b.length);
    let results: ReconcileResult[] = [];
    let chain = Promise.resolve();

    sortedUris.forEach((uri, i) => {
      chain = chain.then(() =>
        this.getEntityTypes(uri, this.sparqlEndpoint).then((types) => {
          results.push({
            id: uri,
            name,
            type: types,
            score: i === 0 ? 100 : 99,
            match: true,
          });
        }),
      );
    });

    return chain.then(() => results);
  }

  async runSparqlSearch(
    name: string,
    typeUri?: string,
    includeTypes: boolean = false,
  ) {
    console.log(
      `Chargement de la configuration SHACL pour le projet ${this.projectId}`,
    );

    // Nouvelle methode
    const { postProcessor } = await getSHACLConfig(this.projectId);

    let escapedName = name.replace(/"/g, '\\"');
    // fisrst lettre of escapedName to uppercase
    escapedName = escapedName.charAt(0).toUpperCase() + escapedName.slice(1);
    const normalized = escapedName.toLowerCase();
    /*console.log("normalized value :", normalized);
    console.log(
      `Recherche SPARQL pour "${name}" (type: ${typeUri || "none"})...`,
    );
    */
    // QUERY 1 : rdfs:label

    const query1 = `
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?x WHERE {
      { 
       { ?x rdfs:label "${escapedName}"@en } 
        UNION 
       { ?x rdfs:label "${escapedName}"@fr } 
        UNION
        { ?x rdfs:label "${normalized}"@en }
        UNION
        { ?x rdfs:label "${normalized}"@fr }
      }
    }
    LIMIT ${this.maxResults}
    `;

    let bindings: any[] = [];

    return axios
      .get(
        `${this.sparqlEndpoint}?query=${encodeURIComponent(
          query1,
        )}&format=json`,
        {
          timeout: 60000,
          family: 4,
        },
      )
      .then((response1) => {
        bindings = response1.data.results.bindings;
        if (bindings.length > 0) return bindings;

        //
        // QUERY 2 : SKOS prefLabel / altLabel

        const query2 = `
       PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?x WHERE {
          {
            { ?x skos:prefLabel|skos:altLabel|skos:notation "${escapedName}"@en }
            UNION
            { ?x skos:prefLabel|skos:altLabel|skos:notation "${escapedName}"@fr }
            UNION
            { ?x skos:prefLabel|skos:altLabel|skos:notation "${normalized}"@en }
            UNION
            { ?x skos:prefLabel|skos:altLabel|skos:notation "${normalized}"@fr }
          }
        }
        LIMIT ${this.maxResults}
      `;

        return axios
          .get(
            `${this.sparqlEndpoint}?query=${encodeURIComponent(
              query2,
            )}&format=json`,
            {
              timeout: 60000,
              family: 4,
            },
          )
          .then((response2) => {
            bindings = response2.data.results.bindings;
            if (bindings.length > 0) return bindings;

            //
            // QUERY 3 : SHACL-based search (avec post-processing SPARQL)

            const typeTriple = typeUri ? `?x a <${typeUri}> .` : ``;

            let query3 = `
            PREFIX foaf: <http://xmlns.com/foaf/0.1/>
            PREFIX dct: <http://purl.org/dc/terms/>
            PREFIX dc: <http://purl.org/dc/elements/1.1/>
            PREFIX schema: <http://schema.org/>

            SELECT ?x WHERE {
              ${typeTriple}
              ?x foaf:name|dct:title|dc:title|dct:identifier|dc:identifier|schema:name ?literal .
              FILTER(LCASE(STR(?literal)) = LCASE("${escapedName}"))
            }
            LIMIT ${this.maxResults}
          `;

            // remplace par expandSparql
            console.log("$$$ Avant expansion SHACL :", query3);

            query3 = postProcessor.expandSparql(query3, {});

            console.log("$$$ Après expansion SHACL :", query3);

            return axios
              .get(
                `${this.sparqlEndpoint}?query=${encodeURIComponent(
                  query3,
                )}&format=json`,
                {
                  timeout: 60000,
                  family: 4,
                },
              )
              .then((response3) => response3.data.results.bindings);
          });
      })
      .then((bindingsFinal) => bindingsFinal.map((b: any) => b.x.value))
      .catch((err) => {
        console.error(`SPARQL request error for "${name}":`, err);
        return [];
      });
  }

  getEntityTypes(uri: string, sparqlEndpoint: string) {
    const typesQuery = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT DISTINCT ?type ?label WHERE {
        <${uri}> rdf:type ?type .
        OPTIONAL { ?type rdfs:label ?label }
      }
      LIMIT 10
    `;

    const url = `${sparqlEndpoint}?query=${encodeURIComponent(
      typesQuery,
    )}&format=json`;

    return axios
      .get(url, { timeout: 60000, family: 4 })
      .then((response) => {
        const bindings = response.data.results.bindings;

        if (bindings.length === 0)
          return [{ id: "http://www.w3.org/2002/07/owl#Thing", name: "Thing" }];

        return bindings.map((b: any) => ({
          id: b.type.value,
          name: b.label?.value || b.type.value.split("/").pop() || "Unknown",
        }));
      })
      .catch((err) => {
        console.error(`Error fetching types for ${uri}:`, err);
        return [{ id: "http://www.w3.org/2002/07/owl#Thing", name: "Thing" }];
      });
  }
}
