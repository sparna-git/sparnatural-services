import fs from "fs";
import path from "path";

import {
  RdfStoreReader,
  ShaclModel,
  ShaclSparqlPostProcessor,
} from "rdf-shacl-commons";

import { ConfigProvider } from "./ConfigProvider";

const SHACL_CACHE: Record<
  string,
  { model: ShaclModel; postProcessor: ShaclSparqlPostProcessor }
> = {};

const SHACL_TTL_CACHE: Record<
  string,
  { ttl: string; firstPath: string }
> = {};

/**
 * Load and concatenate the raw Turtle SHACL files configured for a project.
 * Handles both single-file and space-separated multi-file configs.
 * Result is cached per project key.
 */
export function loadShaclTtl(projectKey: string): { ttl: string; firstPath: string } {
  if (SHACL_TTL_CACHE[projectKey]) {
    return SHACL_TTL_CACHE[projectKey];
  }

  const shaclConfig =
    ConfigProvider.getInstance().getConfig().projects[projectKey]?.shacl;

  if (!shaclConfig) {
    throw new Error(
      `Aucun fichier SHACL configuré pour le projet '${projectKey}'`,
    );
  }

  const shaclPaths: string[] = Array.isArray(shaclConfig)
    ? shaclConfig
    : shaclConfig.split(/\s+/).filter(Boolean);

  let ttl = "";
  for (const filePath of shaclPaths) {
    const absolutePath = path.join(__dirname, "../../", filePath.trim());
    console.log(`[SHACL] Lecture du fichier SHACL : ${absolutePath}`);
    ttl += fs.readFileSync(absolutePath, "utf8") + "\n";
  }

  console.log(`[SHACL] ${shaclPaths.length} fichier(s) SHACL chargé(s)`);

  const entry = { ttl, firstPath: shaclPaths[0] };
  SHACL_TTL_CACHE[projectKey] = entry;
  return entry;
}

export async function getSHACLConfig(projectKey: string) {
  if (SHACL_CACHE[projectKey]) {
    return SHACL_CACHE[projectKey];
  }

  const { ttl: ttlContent, firstPath } = loadShaclTtl(projectKey);

  // 1) Construire le store RDF (type laissé en ANY)
  const store: any = await new Promise((resolve) => {
    RdfStoreReader.buildStoreFromString(ttlContent, firstPath, resolve);
  });

  // 2) Skolemisation
  ShaclModel.skolemizeAnonymousPropertyShapes(store);

  // 3) Construire le modèle SHACL
  const shaclModel = new ShaclModel(store as any);

  // 4) Post-processor SPARQL
  const postProcessor = new ShaclSparqlPostProcessor(shaclModel);

  SHACL_CACHE[projectKey] = { model: shaclModel, postProcessor };

  console.log(
    `[SHACL] Modèle SHACL construit (${store.countQuads(
      null,
      null,
      null,
      null,
    )} triples)`,
  );

  return SHACL_CACHE[projectKey];
}
