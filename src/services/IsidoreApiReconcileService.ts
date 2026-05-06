import axios from "axios";
import { injectable } from "tsyringe";
import {
  ReconcileInput,
  ReconcileOutput,
  ReconcileServiceIfc,
  ManifestType,
} from "./ReconcileServiceIfc";

const ISIDORE_RESOURCE_SUGGEST_URL =
  "https://api.isidore.science/resource/suggest";
const ISIDORE_SOURCE_SUGGEST_URL = "https://api.isidore.science/source/suggest";

const ISIDORE_AGENT_PREFIX = "http://isidore.science/a/";
const ISIDORE_SOURCE_PREFIX = "http://isidore.science/source/";

export type IsidoreEntityType = "agent" | "subject" | "source";

export interface IsidoreCandidate {
  uri: string;
  label: string;
}

/**
 * Maps a class IRI (from SHACL NodeShape targetClass) to an IsidoreEntityType.
 * Falls back to "subject" when unknown.
 */
export function classIriToIsidoreType(classIri?: string): IsidoreEntityType {
  if (!classIri) return "subject";
  if (classIri === "http://xmlns.com/foaf/0.1/Agent") return "agent";
  if (classIri === "http://isidore.science/class/Source") return "source";
  return "subject";
}

/**
 * Calls the right ISIDORE suggest endpoint based on the entity type and
 * returns resolved candidates (full URI + label).
 */
export async function getIsidoreSuggestCandidates(
  query: string,
  entityType: IsidoreEntityType,
  replies = 15,
): Promise<IsidoreCandidate[]> {
  const isSource = entityType === "source";
  const url = new URL(
    isSource ? ISIDORE_SOURCE_SUGGEST_URL : ISIDORE_RESOURCE_SUGGEST_URL,
  );
  url.searchParams.set("q", query);
  url.searchParams.set("replies", String(replies));

  console.log(`[isidore-api] suggest (${entityType}) -> ${url.toString()}`);

  try {
    const response = await axios.get<string>(url.toString(), {
      timeout: 8000,
      headers: { Accept: "application/xml, text/xml, */*" },
      responseType: "text",
    });

    return parseXml(response.data, entityType);
  } catch (err: any) {
    console.error(
      `[isidore-api] suggest failed for "${query}":`,
      err?.message ?? err,
    );
    return [];
  }
}

function parseXml(xml: string, entityType: string): IsidoreCandidate[] {
  if (entityType === "source") {
    return extractReplies(xml, ISIDORE_SOURCE_PREFIX);
  }

  const targetSection = entityType === "agent" ? "creators" : "subjects";
  const repliesRegex =
    /<replies\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/replies>/g;
  let m: RegExpExecArray | null;

  while ((m = repliesRegex.exec(xml)) !== null) {
    if (m[1] !== targetSection) continue;
    const prefix = entityType === "agent" ? ISIDORE_AGENT_PREFIX : undefined;
    return extractReplies(m[2], prefix);
  }

  return [];
}

function extractReplies(xml: string, prefix?: string): IsidoreCandidate[] {
  const candidates: IsidoreCandidate[] = [];
  const replyRegex = /<reply\b[^>]*\blabel="([^"]*)"[^>]*>([\s\S]*?)<\/reply>/g;
  let m: RegExpExecArray | null;

  while ((m = replyRegex.exec(xml)) !== null) {
    const label = m[1].trim();
    const uriMatch =
      /<option\b[^>]*\bkey="uri"\s+value="([^"]*)"[^>]*\/?>/i.exec(m[2]);
    if (!uriMatch) continue;

    const rawUri = uriMatch[1].trim();
    if (!rawUri || !label) continue;

    const uri = prefix && !rawUri.startsWith("http") ? prefix + rawUri : rawUri;
    candidates.push({ uri, label });
  }

  return candidates;
}

/**
 * Reconciliation service that queries the ISIDORE API.
 * Returns empty results when no type is provided (letting a chained fallback service handle it)
 * or when the API returns nothing.
 */
@injectable({ token: "IsidoreApiReconcileService" })
export class IsidoreApiReconcileService implements ReconcileServiceIfc {
  async reconcileQueries(
    queries: ReconcileInput,
    _includeTypes: boolean,
  ): Promise<ReconcileOutput> {
    const output: ReconcileOutput = {};

    for (const [key, qobj] of Object.entries(queries)) {
      if (!qobj.type) {
        // No type → cannot determine ISIDORE category, return empty to let chain fall through
        output[key] = { result: [] };
        continue;
      }

      const entityType = classIriToIsidoreType(qobj.type);
      const candidates = await getIsidoreSuggestCandidates(qobj.query, entityType);

      output[key] = {
        result: candidates.map((c, i) => ({
          id: c.uri,
          name: c.label,
          score: 90 - i,
          match: candidates.length === 1,
        })),
      };
    }

    return output;
  }

  async resolveQueryUris(parsedQuery: any): Promise<any> {
    return parsedQuery;
  }

  async buildManifest(): Promise<ManifestType> {
    throw new Error("IsidoreApiReconcileService does not support manifest");
  }
}
