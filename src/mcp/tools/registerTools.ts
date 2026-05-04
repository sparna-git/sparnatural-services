import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import type { ProjectConfigAdapter } from "../utils/projectConfigAdapter";

// This file centralizes registration of all MCP tools for the project.
interface RegisterToolsOptions {
  projectConfigAdapter: ProjectConfigAdapter;
  projectId: string;
}

// Registers the MCP tools used to inspect the schema, reconcile entities, and execute finalized SPARQL queries.
export function registerTools(
  server: McpServer,
  options: RegisterToolsOptions,
): void {
  const { projectConfigAdapter, projectId } = options;

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
        structuredContent: payload,
      };
    },
  );
  /*
  server.registerTool(
    "inspect_schema_shacl",
    {
      title: "Inspect Schema SHACL",
      description: `Step 1 of the query workflow for project '${projectId}'. Returns the full raw SHACL document and must be used first to inspect the complete schema structure, understand how shapes and properties are connected, and identify valid graph paths before any query construction.`,
      inputSchema: {},
    },
    async () => {
      try {
        const shacl = await projectConfigAdapter.readShacl(projectId);

        return {
          content: [
            {
              type: "text",
              text: shacl,
            },
          ],
          structuredContent: {
            projectId,
            shacl,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `inspect_schema_shacl failed: ${message}`,
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
  */

  // The following tools require sparnatural_discover_nodeshapes to be called first to inspect the schema and identify relevant NodeShapes, classes, and properties. This is necessary to use them correctly and avoid imprecise results or errors.
  server.registerTool(
    `${projectId}_discover_nodeshapes`,
    {
      title: `Discover graph structure of project ${projectId} in SHACL`,
      description: `MANDATORY first step of the query workflow for project '${projectId}'. You MUST call this before ${projectId}_reconcile_entities and ${projectId}_query_sparql. Returns the SHACL node shapes, their targets, and available properties. This will provide you with the classes and property identifiers to write correct SPARQL queries.`,
      inputSchema: {
        lang: z
          .string()
          .length(2)
          .optional()
          .describe(
            "Optional 2-letter language code (e.g. 'fr', 'en', 'de') to select the preferred language for labels, descriptions, and agent instructions. Defaults to 'fr'. If the requested language is missing for a given shape/property, the parser falls back to any other language available in the SHACL file.",
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
            "Prefix declarations from the SHACL file. Keys are prefix names (e.g. 'med'), values are namespace URIs. All IRIs in nodeshapes are already compacted using these prefixes.",
          ),
        nodeshapes: z
          .array(
            z.object({
              shapeIri: z.string().describe("IRI of this NodeShape."),
              label: z
                .string()
                .optional()
                .describe("Human-readable label of the shape."),
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
                  "Specific instructions for the agent on how to use this shape in queries.",
                ),
              targetClasses: z
                .array(z.string())
                .describe(
                  "The rdf:type IRIs of instances described by this NodeShape. Use them as rdf:type constraints in SPARQL queries.",
                ),
              targetSparql: z
                .array(z.string())
                .optional()
                .describe("SPARQL-based target definitions, if any."),
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
                        "Specific instructions for the agent on how to use this property in queries.",
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
                        "Maximum cardinality. If 1, expect a single value per instance.",
                      ),
                    classes: z
                      .array(z.string())
                      .optional()
                      .describe(
                        "When present, this is an object property pointing to instances of these classes. Follow the link to the corresponding NodeShape to discover further predicates.",
                      ),
                    datatypes: z
                      .array(z.string())
                      .optional()
                      .describe(
                        "When present, this is a datatype property holding literal values of this XSD/RDF datatype.",
                      ),
                    values: z
                      .array(z.string())
                      .optional()
                      .describe(
                        "Closed list of allowed values (sh:in). The property can ONLY have one of these values — use them in VALUES or FILTER constraints. Do NOT query for values outside this list.",
                      ),
                  }),
                )
                .describe("The declared properties of this NodeShape."),
            }),
          )
          .describe("The list of all NodeShapes in the schema."),
      },
    },
    async ({ lang }) => {
      try {
        const { shapes, prefixes } =
          await projectConfigAdapter.getShaclNodeShapes(projectId, lang);

        const prefixesRecord = Object.fromEntries(
          prefixes.map(([uri, p]) => [p.slice(0, -1), uri]),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { prefixes: prefixesRecord, shapes },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            projectId,
            prefixes: prefixesRecord,
            nodeshapes: shapes,
          },
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
      description: `Step 2 of the query workflow for project '${projectId}'. REQUIRES ${projectId}_discover_graph_structure first — without it, the 'type' parameter cannot be set correctly and results will be imprecise or wrong. Reconciles user-provided entity labels to candidate IRIs from the project knowledge graph. The resolved IRI must then be injected directly into the SPARQL query produced in step 3 — do not match on rdfs:label once an entity has been reconciled.

  How to call it correctly:
    - For EACH entity label the user mentioned, add one entry to 'queries' with BOTH 'query' (the label) AND 'type' (the class IRI of the entity, taken from the targetClass of the matching node shape discovered in step 1). Passing 'type' improves precision and is expected whenever a class is known from the schema.
    - The 'type' value MUST be a class IRI that exists in the SHACL schema returned by ${projectId}_discover_graph_structure (i.e. one of the targetClasses of a node shape). NEVER use a class IRI that was not returned by ${projectId}_discover_graph_structure — guessed or external class IRIs will produce wrong or empty results.
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
              type: z
                .string()
                .optional()
                .describe(
                  "Class IRI used to constrain the reconciliation search to entities of that class. MUST be taken from the targetClasses of a NodeShape returned by sparnatural_discover_nodeshapes — do NOT use external or guessed class IRIs. Without a valid type from the schema, reconciliation will fall back to a less precise SPARQL-only search.",
                ),
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
    },
    async ({ queries }) => {
      try {
        const result = await projectConfigAdapter.reconcileEntities(
          projectId,
          queries,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: {
            projectId,
            result,
          },
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
          structuredContent: {
            projectId,
            error: message,
          },
        };
      }
    },
  );

  // ${projectId}_query_sparql tool used to execute the finalized SPARQL query after schema inspection and entity reconciliation.
  server.registerTool(
    `${projectId}_query_sparql`,
    {
      title: `Execute Final SPARQL for project ${projectId}`,
      description: `Step 3 of the query workflow for project '${projectId}'. REQUIRES ${projectId}_discover_graph_structure first — queries built without inspecting the schema will fail or return incorrect results because class URIs, predicates, and graph paths are not guessable. Executes a finalized SPARQL query against the configured endpoint. The query must be grounded in the SHACL structure: prefer explicit rdf:type constraints when they are known from the schema, use OPTIONAL and GROUP_CONCAT as appropriate depending on property cardinalities, use DISTINCT when needed to avoid duplicate rows or overcounting, and prefer grouping by resources rather than labels alone when labels may be ambiguous. If an entity has already been reconciled to a specific IRI, use that IRI directly and do not add redundant label-based regex or text filters for the same entity. Do not use this tool for schema exploration, property guessing, or trial-and-error query construction. Do not add FILTER(lang(...)) constraints unless the user explicitly requests a specific language. Always include a LIMIT clause in the query. Start with LIMIT 20 and present the results to the user. If the user wants more, increase progressively (e.g. 100, 500).`,
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
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: {
            projectId,
            executedQuery: query,
            result,
          },
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
          structuredContent: {
            projectId,
            error: message,
          },
        };
      }
    },
  );
}
