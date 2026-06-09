import axios from "axios";
import { ConfigProvider } from "../../config/ConfigProvider";
import { AppConfig } from "../../config/AppConfig";

import { getSHACLConfig, loadShaclTtl } from "../../config/SCHACL";
import { ShapesGraph } from "rdf-shacl-commons";
import {
  extractNodeShapes,
  extractNodeShapesOverview,
  extractPrefixesFromTtl,
  type NodeShapeInfo,
  type NodeShapeOverviewInfo,
} from "./shaclParser";
import type {
  ReconcileInput,
  ReconcileOutput,
} from "../../services/reconciliation/interfaces/ReconcileServiceIfc";
import type {
  UseCase,
  TerminologyMapping,
  FewShot,
} from "../../config/ProjectConfig";
import { loadFewShots } from "../../config/FewShots";

export interface ProjectConfig {
  projectId: string;
  sparqlEndpoint: string;
  shaclPath?: string;
  shaclTypes?: string[];
  useCases?: UseCase[];
  terminology?: TerminologyMapping[];
  fewShotsFile?: string;
}

/**
 * Adapter contract used by the MCP layer.
 */
export interface ProjectConfigAdapter {
  getProjectConfig(projectId: string): Promise<ProjectConfig>;
  executeSparql(
    projectId: string,
    query: string,
  ): Promise<Record<string, unknown>>;
  getShaclNodeShapes(
    projectId: string,
    lang?: string,
    shapes?: string[],
  ): Promise<{ shapes: NodeShapeInfo[]; prefixes: [string, string][] }>;
  getShaclNodeShapesOverview(
    projectId: string,
    lang?: string,
  ): Promise<{ shapes: NodeShapeOverviewInfo[]; prefixes: [string, string][] }>;
  getShapesGraphMeta(
    projectId: string,
    lang?: string,
  ): Promise<{
    title?: string;
    description?: string;
    agentInstruction?: string;
  }>;

  reconcileEntities(
    projectId: string,
    queries: ReconcileInput,
    includeTypes?: boolean,
  ): Promise<ReconcileOutput>;
  checkSparqlReachable(projectId: string): Promise<boolean>;
  /** Returns the curated NL+SPARQL samples for the project, or `undefined`
   *  if no `fewShotsFile` is configured or the file is missing. */
  getFewShots(projectId: string): Promise<FewShot[] | undefined>;
}

/**
 * Adapter that reads project configuration from the existing
 * ConfigProvider (YAML-based) used by the rest of sparnatural-platform.
 */
export class ConfigBackedProjectConfigAdapter implements ProjectConfigAdapter {
  async getProjectConfig(projectId: string): Promise<ProjectConfig> {
    const config = ConfigProvider.getInstance().getConfig();
    const projectConfig = config.projects?.[projectId];

    if (!projectConfig) {
      throw new Error(
        `Unknown project '${projectId}'. Available projects: ${Object.keys(config.projects ?? {}).join(", ")}`,
      );
    }

    if (!projectConfig.sparqlEndpoint) {
      throw new Error(
        `No sparqlEndpoint configured for project '${projectId}'.`,
      );
    }

    return {
      projectId,
      sparqlEndpoint: projectConfig.sparqlEndpoint,
      shaclPath: projectConfig.shacl,
      shaclTypes: projectConfig.shaclTypes,
      useCases: projectConfig.useCases,
      terminology: projectConfig.terminology,
      fewShotsFile: projectConfig.fewShotsFile,
    };
  }

  async getFewShots(projectId: string): Promise<FewShot[] | undefined> {
    const { fewShotsFile } = await this.getProjectConfig(projectId);
    return loadFewShots(fewShotsFile);
  }

  // For simplicity, this method directly executes the SPARQL query against the endpoint.
  // in review "usr sparql route or not with creating a sheard service"
  async executeSparql(
    projectId: string,
    query: string,
  ): Promise<Record<string, unknown>> {
    const config = await this.getProjectConfig(projectId);

    const response = await axios({
      method: "POST",
      url: config.sparqlEndpoint,
      timeout: 60_000, // 60 seconds timeout
      headers: {
        Accept: "application/sparql-results+json, application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: new URLSearchParams({ query }),
    });

    return response.data;
  }

  // Ping the SPARQL endpoint with a cheap ASK query, timeboxed to 2s.
  // Returns true if the endpoint replied 2xx within the timeout, false otherwise.
  async checkSparqlReachable(projectId: string): Promise<boolean> {
    try {
      const config = await this.getProjectConfig(projectId);
      await axios({
        method: "POST",
        url: config.sparqlEndpoint,
        timeout: 2000,
        headers: {
          Accept: "application/sparql-results+json, application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        data: new URLSearchParams({ query: "ASK { ?s ?p ?o }" }),
      });
      return true;
    } catch {
      return false;
    }
  }

  // get NodeShapes from the SHACL file, optionally filtered by shapeIri
  async getShaclNodeShapes(
    projectId: string,
    lang = "fr",
    shapes?: string[],
  ): Promise<{ shapes: NodeShapeInfo[]; prefixes: [string, string][] }> {
    await this.getProjectConfig(projectId);
    const { ttl } = loadShaclTtl(projectId);
    const { model } = await getSHACLConfig(projectId);
    const prefixes = extractPrefixesFromTtl(ttl);
    // Extract shapes in compact form (when prefixes present) for returning
    const extractedCompact = extractNodeShapes(model, lang, prefixes);

    // If a shapes filter is provided, accept either compacted prefixes
    // (e.g. "med:Voie") or full IRIs (e.g. "http://.../medicament/Voie").
    if (shapes && shapes.length > 0) {
      // Also extract raw IRIs (no compaction) to allow matching full IRIs
      const extractedRaw = extractNodeShapes(model, lang, []);
      const filterSet = new Set(shapes);

      const filtered: NodeShapeInfo[] = [];
      for (let i = 0; i < extractedCompact.length; i++) {
        const compactIri = extractedCompact[i].shapeIri;
        const rawIri = extractedRaw[i]?.shapeIri;
        if (filterSet.has(compactIri) || filterSet.has(rawIri)) {
          filtered.push(extractedCompact[i]);
        }
      }

      return { shapes: filtered, prefixes };
    }

    return { shapes: extractedCompact, prefixes };
  }

  // get compact overview (topology only, no descriptions/agentInstructions)
  async getShaclNodeShapesOverview(
    projectId: string,
    lang = "fr",
  ): Promise<{
    shapes: NodeShapeOverviewInfo[];
    prefixes: [string, string][];
  }> {
    await this.getProjectConfig(projectId);
    const { ttl } = loadShaclTtl(projectId);
    const { model } = await getSHACLConfig(projectId);
    const prefixes = extractPrefixesFromTtl(ttl);
    const shapes = extractNodeShapesOverview(model, lang, prefixes);
    return { shapes, prefixes };
  }

  async getShapesGraphMeta(
    projectId: string,
    lang = "fr",
  ): Promise<{
    title?: string;
    description?: string;
    agentInstruction?: string;
  }> {
    const { model } = await getSHACLConfig(projectId);
    const sg = new ShapesGraph(model);
    return {
      title: sg.getTitle(lang),
      //description: sg.getDescription(lang),
      agentInstruction: sg.getAgentInstruction(lang),
    };
  }

  async reconcileEntities(
    projectId: string,
    queries: ReconcileInput,
    includeTypes = false,
  ): Promise<ReconcileOutput> {
    const project = AppConfig.getInstance().getProject(projectId);
    return project.reconcileService.reconcileQueries(queries, includeTypes);
  }
}
