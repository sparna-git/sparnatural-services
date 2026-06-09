import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import type { ProjectConfigAdapter } from "../utils/projectConfigAdapter";
import { buildSchemaOverviewMarkdown } from "../utils/overviewMarkdown";

// This file centralizes registration of all MCP tools for the project.
interface RegisterToolsOptions {
  projectConfigAdapter: ProjectConfigAdapter;
  projectId: string;
}

// Registers the MCP tools used to inspect the schema, reconcile entities, and execute finalized SPARQL queries.
export async function registerTools(
  server: McpServer,
  options: RegisterToolsOptions,
): Promise<void> {
  const { projectConfigAdapter, projectId } = options;

  const [{ shaclTypes, useCases }, shapesGraphMeta] = await Promise.all([
    projectConfigAdapter.getProjectConfig(projectId),
    projectConfigAdapter.getShapesGraphMeta(projectId).catch(() => ({
      title: undefined,
      description: undefined,
      agentInstruction: undefined,
    })),
  ]);

  const fewShotsStepHint = ` Then call ${projectId}_get_few_shots once to load curated NL+SPARQL examples.`;

  const shapesGraphContext =
    shapesGraphMeta.agentInstruction ??
    [shapesGraphMeta.title, shapesGraphMeta.description]
      .filter(Boolean)
      .join("\n");

  console.error(
    `[registerTools][${projectId}] ShapesGraph meta:`,
    JSON.stringify(shapesGraphMeta),
    "→ context:",
    shapesGraphContext ?? "(none)",
  );

  const discoverDescription =
    `${projectId}_discover_nodeshapes : MANDATORY before writing ANY SPARQL query for project '${projectId}'. ` +
    `Call this for every NodeShape whose predicates you need in the current query that you have NOT already discovered earlier in this conversation. ` +
    `If a shape's full details were already returned by a previous ${projectId}_discover_nodeshapes call in THIS conversation, reuse them — do NOT call this tool again for that same shape. ` +
    `Conversely, never rely on the schema_overview topology or your training data to infer predicates: any shape not yet discovered MUST be passed here, including new shapes required by follow-up questions. ` +
    `Identify the not-yet-discovered shapes needed for the current query, then call this tool with exactly those shape IRIs before writing any SPARQL. ` +
    `Never write SPARQL for a shape that has neither been discovered now nor in a previous call this conversation — the schema_overview topology is NOT sufficient to infer correct predicate IRIs or directions. ` +
    `Returns full SHACL details: exact predicate IRIs, property directions, cardinalities, allowed values, and agent instructions.` +
    (shapesGraphContext ? `\n\n${shapesGraphContext}` : "");

  const typeSchema =
    shaclTypes && shaclTypes.length > 0
      ? z
          .enum(shaclTypes as [string, ...string[]])
          .optional()
          .describe(
            "Class IRI used to constrain the reconciliation search to entities of that class. MUST be one of the listed values from the SHACL schema — do NOT use external or guessed class IRIs. Without a valid type from the schema, reconciliation will fall back to a less precise SPARQL-only search.",
          )
      : z
          .string()
          .optional()
          .describe(
            "Class IRI used to constrain the reconciliation search to entities of that class. MUST be taken from the targetClasses of a NodeShape returned by sparnatural_discover_nodeshapes — do NOT use external or guessed class IRIs. Without a valid type from the schema, reconciliation will fall back to a less precise SPARQL-only search.",
          );

  server.registerTool(
    "healthcheck",
    {
      title: "Healthcheck",
      description:
        "Returns MCP server status plus SPARQL endpoint reachability and SHACL loading status for the project.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true, // pings external SPARQL endpoint
      },
    },
    async () => {
      // Check SPARQL reachability (2s timeout, returns false on any error)
      const sparqlReachable =
        await projectConfigAdapter.checkSparqlReachable(projectId);

      // Check SHACL loading: try to parse the NodeShapes. If it throws, not loaded.
      let shaclLoaded = false;
      try {
        const { shapes } =
          await projectConfigAdapter.getShaclNodeShapes(projectId);
        shaclLoaded = shapes.length > 0;
      } catch {
        shaclLoaded = false;
      }

      const ok = sparqlReachable && shaclLoaded;

      const payload = {
        ok,
        server: "sparnatural-mcp",
        projectId,
        sparqlReachable,
        shaclLoaded,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    `${projectId}_schema_overview`,
    {
      title: `Schema overview of project ${projectId}`,
      description:
        `${projectId}_schema_overview : FIRST step of the query workflow for project '${projectId}'. ` +
        `Call once per conversation to get a Markdown synthesis of the data model. ` +
        `Returns: a section "NodeShapes principales" with each key shape's label, description, identifier predicates, label predicate, and relations to other key shapes; plus a compact list of secondary shapes. ` +
        `This view is intentionally a high-level synthesis, not a complete schema dump. ` +
        `WARNING: The overview does NOT carry enough detail to write correct SPARQL — full property paths, cardinalities, allowed values, and agent instructions are only available via ${projectId}_discover_nodeshapes. ` +
        `After calling this tool, you MUST call ${projectId}_discover_nodeshapes with the specific shape IRIs needed for each query before writing any SPARQL.${fewShotsStepHint} ` +
        `For every new user question, re-identify which shapes are needed and call ${projectId}_discover_nodeshapes for any of them not yet discovered in this conversation — but reuse the details of shapes already discovered earlier instead of calling again for them.` +
        (shapesGraphContext ? `\n\n${shapesGraphContext}` : ""),
      inputSchema: {
        lang: z
          .string()
          .length(2)
          .optional()
          .describe(
            "Optional 2-letter language code (e.g. 'fr', 'en'). Defaults to 'fr'.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ lang }) => {
      try {
        const effectiveLang = lang ?? "fr";
        const [{ shapes, prefixes }, meta] = await Promise.all([
          projectConfigAdapter.getShaclNodeShapesOverview(
            projectId,
            effectiveLang,
          ),
          projectConfigAdapter
            .getShapesGraphMeta(projectId, effectiveLang)
            .catch(() => ({})),
        ]);

        const prefixesRecord = Object.fromEntries(
          prefixes.map(([uri, p]) => [p.slice(0, -1), uri]),
        );

        const markdown = buildSchemaOverviewMarkdown({
          projectId,
          lang: effectiveLang,
          meta,
          shapes,
          prefixes: prefixesRecord,
          useCases,
        });

        return {
          content: [{ type: "text", text: markdown }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            { type: "text", text: `schema_overview failed: ${message}` },
          ],
        };
      }
    },
  );

  // Few-shot examples tool. Always registered: the samples file is loaded
  // lazily on each call so the server doesn't need to know about it at
  // startup. If the project has no `fewShotsFile` configured (or the file
  // is empty / missing), the handler simply returns an empty list.
  server.registerTool(
    `${projectId}_get_few_shots`,
    {
      title: `Curated NL+SPARQL examples for project ${projectId}`,
      description:
        `${projectId}_get_few_shots : Step 2 of the query workflow for project '${projectId}'. ` +
        `Call ONCE per conversation, right after ${projectId}_schema_overview and BEFORE any other tool. ` +
        `Returns a curated list of natural-language questions paired with their expected SPARQL. ` +
        `These samples are AUTHORITATIVE templates validated against the live schema by the project owner — trust them.\n\n` +
        `How to use the result:\n` +
        `(a) EXACT MATCH — the user question matches a sample word-for-word OR has identical intent and entities: ` +
        `execute the sample's \`sparql\` directly via ${projectId}_query_sparql. ` +
        `SKIP ${projectId}_discover_nodeshapes AND ${projectId}_reconcile_entities entirely — the sample already contains resolved entity IRIs and validated predicates. This is the FAST PATH.\n` +
        `(b) TEMPLATE MATCH — same query pattern but different entity values (e.g. sample is about "ézétimibe", user asks about "metformine"): ` +
        `reuse the sample SPARQL as a template. Call ${projectId}_reconcile_entities ONLY for the substituted entities. ` +
        `You can SKIP ${projectId}_discover_nodeshapes for any shape already covered by the sample — the sample is proof of correct predicate usage.\n` +
        `(c) NO MATCH — fall through to the full workflow: ${projectId}_discover_nodeshapes → ${projectId}_reconcile_entities → ${projectId}_query_sparql. The samples may still inform predicate naming conventions.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const fewShots =
          (await projectConfigAdapter.getFewShots(projectId)) ?? [];
        const payload = { projectId, fewShots };
        return {
          structuredContent: payload,
          content: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `get_few_shots failed: ${message}` }],
        };
      }
    },
  );

  // The following tools require sparnatural_schema_overview to be called first to identify relevant NodeShapes.
  server.registerTool(
    `${projectId}_discover_nodeshapes`,
    {
      title: `Discover graph structure of project ${projectId} in SHACL`,
      description: discoverDescription,
      inputSchema: {
        lang: z
          .string()
          .length(2)
          .optional()
          .describe(
            "Optional 2-letter language code (e.g. 'fr', 'en', 'de') to select the preferred language for labels, descriptions, and agent instructions. Defaults to 'fr'. If the requested language is missing for a given shape/property, the parser falls back to any other language available in the SHACL file.",
          ),
        shapes: z
          .array(z.string())
          .optional()
          .describe(
            "List of NodeShape IRIs (compacted, as returned by schema_overview) to load in full detail. " +
              "Pass every shape whose predicates you will use in the current query that you have NOT already discovered in this conversation — including lookup shapes (e.g. med:GroupeGenerique if you will query group membership). " +
              "You may omit shapes already discovered earlier in this conversation and reuse those results; but do NOT omit a shape just because you think you know its predicates from training data or from the overview topology — those are not reliable, so discover it. " +
              "When omitted, all shapes are returned (use only if you genuinely need the full schema).",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: {
        projectId: z.string().describe("The project identifier."),
        prefixes: z
          .record(z.string(), z.string())
          .describe(
            "Prefix declarations from the SHACL file. Keys are prefix names (e.g. 'med'), values are namespace URIs. All IRIs in node shapes are already compacted using these prefixes.",
          ),
        nodeshapes: z
          .array(
            z.object({
              shapeIri: z.string().describe("IRI of this node shape."),
              label: z
                .string()
                .optional()
                .describe("Human-readable label of the node shape."),
              description: z
                .string()
                .optional()
                .describe(
                  "Human-readable explanation of what this shape represents.",
                ),
              agentInstruction: z
                .string()
                .optional()
                .describe(
                  "Specific instructions for the agent on how to use this shape in queries, e.g. if there are particular restrictions or specific things to know.",
                ),
              targetClasses: z
                .array(z.string())
                .describe(
                  "The rdf:type IRIs of resources targeted by this node shape. Use them as rdf:type constraints in SPARQL queries.",
                ),
              targetSparql: z
                .array(z.string())
                .optional()
                .describe(
                  "SPARQL-based target definitions of the shape, if any. Use the corresponding criterias in SPARQL queries.",
                ),
              properties: z
                .array(
                  z.object({
                    path: z
                      .string()
                      .optional()
                      .describe("The predicate IRI to use in triple patterns."),
                    name: z
                      .string()
                      .optional()
                      .describe("Human-readable name of the property."),
                    description: z
                      .string()
                      .optional()
                      .describe(
                        "Human-readable explanation of what this property represents.",
                      ),
                    agentInstruction: z
                      .string()
                      .optional()
                      .describe(
                        "Specific instructions for the agent on how to use this property in queries, e.g. if there are particular restrictions or specific things to know.",
                      ),
                    minCount: z
                      .number()
                      .optional()
                      .describe(
                        "Minimum cardinality. If >= 1 the property is always present on every instance — do NOT use OPTIONAL. If absent or 0, the property may be missing — use OPTIONAL to avoid losing results.",
                      ),
                    maxCount: z
                      .number()
                      .optional()
                      .describe(
                        "Maximum cardinality. If 1, expect a single value per instance, if absent or greater than one, multiple values may exist for each resource - use a GROUP_CONCAT aggregation to avoid multiplying the lines in the result set.",
                      ),
                    classes: z
                      .array(z.string())
                      .optional()
                      .describe(
                        "When present, indicates that the predicate points to instances of these classes. Follow the link to the corresponding Node Shape to discover further predicates.",
                      ),
                    datatypes: z
                      .array(z.string())
                      .optional()
                      .describe(
                        "When present, indicate that the predicate has literal values with this datatype.",
                      ),
                    values: z
                      .array(z.string())
                      .optional()
                      .describe(
                        "Closed list of allowed values (sh:in). The property can ONLY have one of these values — use them in VALUES or FILTER constraints. Do NOT query for values outside this list.",
                      ),
                  }),
                )
                .describe(
                  "Properties available on resources that are targeted by this node shape.",
                ),
            }),
          )
          .describe("The list of all node shapes in the schema."),
      },
    },
    async ({ lang, shapes: shapesFilter }) => {
      try {
        const { shapes, prefixes } =
          await projectConfigAdapter.getShaclNodeShapes(
            projectId,
            lang,
            shapesFilter,
          );

        const prefixesRecord = Object.fromEntries(
          prefixes.map(([uri, p]) => [p.slice(0, -1), uri]),
        );

        return {
          structuredContent: {
            projectId,
            prefixes: prefixesRecord,
            nodeshapes: shapes,
          },
          content: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `sparnatural_discover_nodeshapes failed: ${message}`,
            },
          ],
          structuredContent: {
            projectId,
            error: message,
          },
        };
      }
    },
  );

  // sparnatural_reconcile_entities tool used to resolve user-provided labels to IRIs from the knowledge graph.
  server.registerTool(
    `${projectId}_reconcile_entities`,
    {
      title: `Reconcile entity labels to IRIs in project ${projectId}`,
      description: `${projectId}_reconcile_entities :Step 3 of the query workflow for project '${projectId}'. REQUIRES ${projectId}_discover_nodeshapesfirst — without it, the 'type' parameter cannot be set correctly and results will be imprecise or wrong. Reconciles user-provided entity labels to candidate IRIs from the project knowledge graph. The resolved IRI must then be injected directly into the SPARQL query produced in step 3 — do not match on rdfs:label once an entity has been reconciled.

  How to call it correctly:
    - For EACH entity label the user mentioned, add one entry to 'queries' with BOTH 'query' (the label) AND 'type' (the class IRI of the entity, taken from the targetClass of the matching node shape discovered in step 1). Passing 'type' improves precision and is expected whenever a class is known from the schema.
    - The 'type' value MUST be a class IRI that exists in the SHACL schema returned by ${projectId}_discover_nodeshapes(i.e. one of the targetClasses of a node shape). NEVER use a class IRI that was not returned by ${projectId}_discover_nodeshapes — guessed or external class IRIs will produce wrong or empty results.
    - When all returned candidates have match: false, present the full list to the user (name + id) and ask them to choose. Only proceed to the SPARQL query once the user has confirmed their choice.`,
      inputSchema: {
        queries: z
          .record(
            z.object({
              query: z
                .string()
                .min(1)
                .describe(
                  "The entity label / name to reconcile, exactly as the user wrote it. Do not paraphrase or translate.",
                ),
              type: typeSchema,
            }),
          )
          .describe(
            "A map of reconciliation keys to { query, type? } objects. One entry per label to resolve. Keys are arbitrary identifiers (e.g. 'author', 'city') used to match results back in the response.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      outputSchema: z
        .object({})
        .catchall(
          z.object({
            result: z
              .array(
                z.object({
                  id: z
                    .string()
                    .describe(
                      "Candidate entity IRI. This is the value to inject directly into the SPARQL query once selected.",
                    ),
                  name: z
                    .string()
                    .describe("Human-readable label of the candidate entity."),
                  type: z
                    .union([
                      z.array(z.string()),
                      z.array(z.object({ id: z.string(), name: z.string() })),
                    ])
                    .optional()
                    .describe(
                      "Class IRIs of the candidate, or {id, name} pairs when type expansion is enabled.",
                    ),
                  score: z
                    .number()
                    .describe("Match confidence score; higher is better."),
                  match: z
                    .boolean()
                    .describe(
                      "True when this candidate is a confident/exact match. If every candidate has match: false, present the list and let the user choose.",
                    ),
                }),
              )
              .describe("Ranked candidate list for this reconciliation key."),
          }),
        )
        .describe(
          "One entry per reconciliation key (same keys as the `queries` input), each holding its ranked candidate list.",
        ),
    },
    async ({ queries }) => {
      try {
        const result = await projectConfigAdapter.reconcileEntities(
          projectId,
          queries,
        );

        return {
          structuredContent: result,
          content: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `sparnatural_reconcile_entities failed: ${message}`,
            },
          ],
        };
      }
    },
  );

  // ${projectId}_query_sparql tool used to execute the finalized SPARQL query after schema inspection and entity reconciliation.
  server.registerTool(
    `${projectId}_query_sparql`,
    {
      title: `Execute Final SPARQL for project ${projectId}`,
      description: `${projectId}_query_sparql : Step 4 of the query workflow for project '${projectId}'. REQUIRES ${projectId}_discover_nodeshapesfirst — queries built without inspecting the schema will fail or return incorrect results because class URIs, predicates, and graph paths are not guessable. Executes a finalized SPARQL query against the configured endpoint. The query must be grounded in the SHACL structure: prefer explicit rdf:type constraints when they are known from the schema, use OPTIONAL and GROUP_CONCAT as appropriate depending on property cardinalities, use DISTINCT when needed to avoid duplicate rows or overcounting, and prefer grouping by resources rather than labels alone when labels may be ambiguous. If an entity has already been reconciled to a specific IRI, use that IRI directly and do not add redundant label-based regex or text filters for the same entity. Do not use this tool for schema exploration, property guessing, or trial-and-error query construction. Do not add FILTER(lang(...)) constraints unless the user explicitly requests a specific language. Always include a LIMIT clause in the query. Start with LIMIT 20 and present the results to the user. If the user wants more, increase progressively (e.g. 100, 500).`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "A finalized, schema-aware SPARQL query built after NodeShape discovery and entity reconciliation when needed. Prefer explicit rdf:type constraints from the schema, use DISTINCT when appropriate, and avoid redundant regex or label filters when a target entity has already been resolved to an exact IRI.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      try {
        const result = await projectConfigAdapter.executeSparql(
          projectId,
          query,
        );

        return {
          structuredContent: result,
          content: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `execute_final_sparql failed: ${message}`,
            },
          ],
        };
      }
    },
  );
}
