/**
 * Shared utility for collecting unresolved URI_NOT_FOUND labels from a SparnaturalQuery (v13 structure)
 * and injecting resolved URIs back after reconciliation.
 *
 * Used by MistralText2QueryService and RestText2QueryService.
 */

const URI_NOT_FOUND = "https://services.sparnatural.eu/api/v1/URI_NOT_FOUND";

export interface LabelToResolve {
  query: string;
  type?: string;
}

// 1. COLLECT — find all URI_NOT_FOUND labels in the query tree
/**
 * Walks the v13 SparnaturalQuery tree and collects every unique
 * URI_NOT_FOUND label that needs reconciliation.
 *
 * @returns A record like { label_0: { query: "France", type: "http://...Country" }, ... }
 */
export function collectUnresolvedLabels(
  parsed: any,
): Record<string, LabelToResolve> {
  const labelsToResolve: Record<string, LabelToResolve> = {};
  const seen = new Set<string>();
  let idx = 0;

  function addLabel(label: string, rdfType?: string) {
    const normalized = label.trim().toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      labelsToResolve[`label_${idx++}`] = {
        query: label,
        type: rdfType,
      };
    }
  }

  /**
   * Checks all terms inside a values[] array for URI_NOT_FOUND.
   * Handles two possible shapes:
   *  - Direct term: { type:"term", subType:"namedNode", value: URI_NOT_FOUND, label:"..." }
   *  - ValuePatternRow (Record<string, Term>): { varName: { ... term ... } }
   */
  function processValues(values: any[], rdfType?: string) {
    if (!Array.isArray(values)) return;

    for (const item of values) {
      if (!item || typeof item !== "object") continue;

      // Case A: item IS a TermLabelledIri directly
      if (isUnresolvedTerm(item)) {
        addLabel(item.label, rdfType);
        continue;
      }

      // Case B: item is a ValuePatternRow → iterate its values
      for (const term of Object.values(item)) {
        if (isUnresolvedTerm(term)) {
          addLabel((term as any).label, rdfType);
        }
      }
    }
  }

  /**
   * Recursively traverses predicateObjectPairs → object → values / nested pairs.
   */
  function traversePairs(pairs: any[]) {
    if (!Array.isArray(pairs)) return;

    for (const pair of pairs) {
      const object = pair?.object;
      if (!object) continue;

      const rdfType = object.variable?.rdfType;

      // Collect from values[]
      if (object.values) {
        processValues(object.values, rdfType);
      }

      // Recurse into nested predicateObjectPairs
      if (object.predicateObjectPairs) {
        traversePairs(object.predicateObjectPairs);
      }
    }
  }

  // Entry point: start from the root where clause
  if (parsed?.where?.predicateObjectPairs) {
    traversePairs(parsed.where.predicateObjectPairs);
  }

  return labelsToResolve;
}

// 2. BUILD MAP — from reconciliation results to label→URI map
/**
 * Builds a Map<normalizedLabel, resolvedUri> from the reconciliation output.
 * This handles duplicates correctly: if the same label appears multiple times
 * in the query, they all get the same resolved URI.
 */
export function buildLabelToUriMap(
  labelsToResolve: Record<string, LabelToResolve>,
  uriResults: Record<string, { result: any[] }>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const [key, labelInfo] of Object.entries(labelsToResolve)) {
    const results = uriResults[key]?.result;

    if (results && results.length > 0) {
      // Pick the result with the highest score
      const best = results.reduce((a: any, b: any) =>
        b.score > a.score ? b : a,
      );

      if (best?.id) {
        map.set(labelInfo.query.trim().toLowerCase(), best.id);
        console.log(`[reconciliation] 🔗 "${labelInfo.query}" → "${best.id}"`);
      }
    } else {
      console.log(`[reconciliation] ⚠️ "${labelInfo.query}" → no URI found`);
    }
  }

  return map;
}

// 3. INJECT — replace URI_NOT_FOUND with resolved URIs
/**
 * Walks the query tree again and replaces every URI_NOT_FOUND value
 * with the resolved URI from the map. Also removes the `metadata` key.
 */
export function injectResolvedUris(
  parsed: any,
  labelToUri: Map<string, string>,
): void {
  function processValues(values: any[]) {
    if (!Array.isArray(values)) return;

    for (const item of values) {
      if (!item || typeof item !== "object") continue;

      // Case A: direct term
      if (isUnresolvedTerm(item)) {
        const resolved = labelToUri.get(item.label.trim().toLowerCase());
        if (resolved) {
          item.value = resolved;
        }
        continue;
      }

      // Case B: ValuePatternRow
      for (const term of Object.values(item)) {
        if (isUnresolvedTerm(term)) {
          const resolved = labelToUri.get(
            (term as any).label.trim().toLowerCase(),
          );
          if (resolved) {
            (term as any).value = resolved;
          }
        }
      }
    }
  }

  function traversePairs(pairs: any[]) {
    if (!Array.isArray(pairs)) return;

    for (const pair of pairs) {
      const object = pair?.object;
      if (!object) continue;

      if (object.values) {
        processValues(object.values);
      }

      if (object.predicateObjectPairs) {
        traversePairs(object.predicateObjectPairs);
      }
    }
  }

  if (parsed?.where?.predicateObjectPairs) {
    traversePairs(parsed.where.predicateObjectPairs);
  }

  // Clean up metadata after reconciliation
  if (parsed.metadata) {
    delete parsed.metadata;
    console.log(
      "[reconciliation] 🧹 'metadata' key removed after reconciliation.",
    );
  }
}

// INTERNAL — helper to detect an unresolved TermLabelledIri
function isUnresolvedTerm(term: any): term is { value: string; label: string } {
  return (
    term &&
    typeof term === "object" &&
    term.subType === "namedNode" &&
    term.value === URI_NOT_FOUND &&
    typeof term.label === "string"
  );
}
