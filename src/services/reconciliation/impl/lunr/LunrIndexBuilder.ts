import axios from "axios";
import https from "https";
import fs from "fs";
import lunr from "lunr";
import { FieldQueryConfig } from "../../../../config/ProjectConfig";
import { getSHACLConfig, listNodeShapeIris } from "../../../../config/SCHACL";
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

  /**
   * The types reconciliation can filter on: the project `shaclTypes` when the
   * YAML lists them, every NodeShape IRI otherwise.
   */
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
      const shapes = listNodeShapeIris(model);
      logger.info(
        {},
        `[lunr-recon] ${shapes.length} NodeShape(s) resolved from the SHACL model.`,
      );
      return shapes;
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

  /**
   * Tags each indexed entity with the types it belongs to, which is what
   * `LunrSearchEngine` filters on when a `type` is passed.
   *
   * One `?entity a <type>` branch per type, then `expandSparql` rewrites them
   * against the data: a `sh:targetClass` becomes its class, a `sh:select`
   * becomes its own pattern. Same translation as the SPARQL and Lucene
   * services. The substitution also hits the `BIND`, so a class shape tags
   * with its class and a `sh:select` shape with the shape IRI.
   */
  async loadTypesFromSparql(
    uriToData: Map<string, UriData>,
    shaclTypes: string[],
  ): Promise<void> {
    if (shaclTypes.length === 0) return;

    const branches = shaclTypes
      .map((t) => `  { ?entity a <${t}> . BIND(<${t}> AS ?value) }`)
      .join("\n  UNION\n");
    let query = `SELECT ?entity ?value WHERE {\n${branches}\n}`;

    try {
      const { postProcessor } = await getSHACLConfig(this.projectId);
      query = postProcessor.expandSparql(query, {});
    } catch {
      logger.info(
        {},
        `[lunr-recon] No SHACL config — types queried without expansion.`,
      );
    }

    const bindings = await this.fetchTargetBindings(query);

    let tagged = 0;
    for (const b of bindings) {
      if (!b.entity || !b.value) continue;
      const data = uriToData.get(b.entity.value);
      if (!data) continue; // no label, so not in the index
      if (!data.types) data.types = [];
      if (data.types.includes(b.value.value)) continue;
      data.types.push(b.value.value);
      tagged++;
    }

    logger.info(
      {},
      `[lunr-recon] Types loaded: ${bindings.length} row(s) for ${shaclTypes.length} type(s), ${tagged} tagged.`,
    );
  }

  /** POST for the type query: no keep-alive and IPv4, as the large RUIM one needs. */
  private async fetchTargetBindings(query: string): Promise<SparqlBinding[]> {
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
    return response.data.results.bindings;
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

  private async resolveQueries(fq: FieldQueryConfig): Promise<string[]> {
    if (fq.query) return [fq.query];
    if (fq.queryFiles?.length)
      return Promise.all(
        fq.queryFiles.map((f) => fs.promises.readFile(f, "utf-8")),
      );
    if (fq.queryFile)
      return [await fs.promises.readFile(fq.queryFile, "utf-8")];
    throw new Error(
      `[lunr-recon] FieldQueryConfig for field "${fq.field}" has neither query nor queryFile(s).`,
    );
  }

  private async loadFieldDocuments(
    fq: FieldQueryConfig,
  ): Promise<FieldBinding[]> {
    logger.info({}, `[lunr-recon] Loading field "${fq.field}"…`);
    const queries = await this.resolveQueries(fq);
    const allBindings = await Promise.all(
      queries.map((q) => this.fetchSparqlBindings(q)),
    );
    const docs = allBindings
      .flat()
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
