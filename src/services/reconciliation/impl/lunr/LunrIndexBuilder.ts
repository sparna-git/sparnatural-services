import axios from "axios";
import https from "https";
import fs from "fs";
import lunr from "lunr";
import { FieldQueryConfig } from "../../../../config/ProjectConfig";
import { getSHACLConfig } from "../../../../config/SCHACL";
import { SparqlBinding, FieldBinding, LegacyBinding, UriData } from "./types";
import { normalizeAccents } from "./lunrPipeline";
import logger from "../../../../utils/logger";

export class LunrIndexBuilder {
  constructor(
    private readonly projectId: string,
    private readonly sparqlEndpoint: string,
    private readonly fieldQueries: FieldQueryConfig[],
    private readonly legacySparqlQuery: string | undefined,
    private readonly fieldBoosts: Map<string, number>,
  ) {}

  async resolveShaclTypes(initialTypes: string[]): Promise<string[]> {
    if (initialTypes.length > 0) {
      logger.info(
        {},
        `[lunr-recon] ${initialTypes.length} SHACL type(s) from config.`,
      );
      return initialTypes;
    }
    try {
      const { model } = await getSHACLConfig(this.projectId);
      const types: string[] = [];
      for (const nodeShape of model.readAllNodeShapes()) {
        const targetClasses = nodeShape.getTargetClasses();
        if (targetClasses.length > 0) {
          for (const tc of targetClasses)
            if (tc.termType === "NamedNode") types.push(tc.value);
        } else if (nodeShape.resource.termType === "NamedNode") {
          types.push(nodeShape.resource.value);
        }
      }
      const resolved = [...new Set(types)];
      logger.info(
        {},
        `[lunr-recon] ${resolved.length} SHACL type(s) resolved from NodeShapes.`,
      );
      return resolved;
    } catch {
      logger.info(
        {},
        `[lunr-recon] No SHACL config — type filtering disabled.`,
      );
      return [];
    }
  }

  async build(
    shaclTypes: string[],
  ): Promise<{ index: lunr.Index; uriToData: Map<string, UriData> }> {
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
      logger.warn(
        {},
        "[lunr-recon] No documents loaded — index will be empty.",
      );
    }

    const uriToData = new Map<string, UriData>();
    for (const [uri, { displayLabel, fields }] of dataByUri) {
      const label =
        displayLabel ?? Object.values(fields).flatMap((s) => [...s])[0] ?? uri;
      const arrayFields: Record<string, string[]> = {};
      for (const [f, set] of Object.entries(fields)) arrayFields[f] = [...set];
      uriToData.set(uri, { label, fields: arrayFields });
    }

    const fieldBoosts = this.fieldBoosts;
    const index = lunr(function () {
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

    if (shaclTypes.length > 0) {
      await this.loadTypesFromSparql(uriToData, shaclTypes);
    }

    return { index, uriToData };
  }

  async loadTypesFromSparql(
    uriToData: Map<string, UriData>,
    shaclTypes: string[],
  ): Promise<void> {
    const inClause = shaclTypes.map((t) => `<${t}>`).join(", ");
    const query = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?entity ?value WHERE {
        ?entity rdf:type ?value .
        FILTER(?value IN (${inClause}))
      }
    `;
    const response = await axios.post<{
      results: { bindings: SparqlBinding[] };
    }>(
      this.sparqlEndpoint,
      new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Connection: "close",
        },
        httpsAgent: new https.Agent({ keepAlive: false }),
        timeout: 60000,
        family: 4,
      },
    );
    const bindings = response.data.results.bindings;
    for (const b of bindings) {
      if (!b.entity || !b.value) continue;
      const data = uriToData.get(b.entity.value);
      if (!data) continue;
      if (!data.types) data.types = [];
      data.types.push(b.value.value);
    }
    logger.info({}, `[lunr-recon] Types loaded: ${bindings.length} triple(s).`);
  }

  async fetchSparqlBindings(query: string): Promise<SparqlBinding[]> {
    const response = await axios.post<{
      results: { bindings: SparqlBinding[] };
    }>(
      this.sparqlEndpoint,
      new URLSearchParams({ query, format: "json" }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
        family: 4,
      },
    );
    return response.data.results.bindings;
  }

  private async resolveQuery(fq: FieldQueryConfig): Promise<string> {
    if (fq.query) return fq.query;
    if (fq.queryFile) return fs.promises.readFile(fq.queryFile, "utf-8");
    throw new Error(
      `[lunr-recon] FieldQueryConfig for field "${fq.field}" has neither query nor queryFile.`,
    );
  }

  private async loadFieldDocuments(
    fq: FieldQueryConfig,
  ): Promise<FieldBinding[]> {
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
    logger.info(
      {},
      "[lunr-recon] Loading entities from SPARQL (legacy query)…",
    );
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
}
