/**
 * Shared utility for collecting unresolved URI_NOT_FOUND labels from a SparnaturalQuery (old structure)
 * and injecting resolved URIs back after reconciliation.
 *
 * Old structure: branches[] → line { s, p, o, sType, oType, criterias[] } → criteria.rdfTerm
 *
 * Used by MistralText2QueryService and RestText2QueryService when working with the old query format.
 */

const URI_NOT_FOUND = "https://services.sparnatural.eu/api/v1/URI_NOT_FOUND";

export interface LabelToResolve {
  query: string;
  type?: string;
}

// 1. COLLECT — find all URI_NOT_FOUND labels in the query tree
/**
 * Walks the old SparnaturalQuery tree (branches → line.criterias → criteria.rdfTerm)
 * and collects every unique URI_NOT_FOUND label that needs reconciliation.
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
   * Checks all criterias in a CriteriaLine for URI_NOT_FOUND rdfTerms.
   */
  function processCriterias(criterias: any[], rdfType?: string) {
    if (!Array.isArray(criterias)) return;

    for (const lc of criterias) {
      if (!lc || typeof lc !== "object") continue;

      const rdfTerm = lc.criteria?.rdfTerm;
      if (isUnresolvedTerm(rdfTerm)) {
        // Use the LabelledCriteria.label as the search query
        addLabel(lc.label, rdfType);
      }
    }
  }

  /**
   * Recursively traverses branches → line.criterias and children.
   */
  function traverseBranches(branches: any[]) {
    if (!Array.isArray(branches)) return;

    for (const branch of branches) {
      const line = branch?.line;
      if (!line) continue;

      // oType is the RDF type of the object
      const rdfType = line.oType;

      if (line.criterias) {
        processCriterias(line.criterias, rdfType);
      }

      // Recurse into children
      if (branch.children) {
        traverseBranches(branch.children);
      }
    }
  }

  // Entry point: start from the root branches
  if (parsed?.branches) {
    traverseBranches(parsed.branches);
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
 * Walks the old query tree again and replaces every URI_NOT_FOUND rdfTerm.value
 * with the resolved URI from the map.
 */
export function injectResolvedUris(
  parsed: any,
  labelToUri: Map<string, string>,
): void {
  function processCriterias(criterias: any[]) {
    if (!Array.isArray(criterias)) return;

    for (const lc of criterias) {
      if (!lc || typeof lc !== "object") continue;

      const rdfTerm = lc.criteria?.rdfTerm;
      if (isUnresolvedTerm(rdfTerm)) {
        const resolved = labelToUri.get(lc.label.trim().toLowerCase());
        if (resolved) {
          rdfTerm.value = resolved;
        }
      }
    }
  }

  function traverseBranches(branches: any[]) {
    if (!Array.isArray(branches)) return;

    for (const branch of branches) {
      const line = branch?.line;
      if (!line) continue;

      if (line.criterias) {
        processCriterias(line.criterias);
      }

      if (branch.children) {
        traverseBranches(branch.children);
      }
    }
  }

  if (parsed?.branches) {
    traverseBranches(parsed.branches);
  }

  // Clean up metadata after reconciliation
  if (parsed.metadata) {
    delete parsed.metadata;
    console.log(
      "[reconciliation] 🧹 'metadata' key removed after reconciliation.",
    );
  }
}

// INTERNAL — helper to detect an unresolved RDFTerm (old structure)
function isUnresolvedTerm(
  rdfTerm: any,
): rdfTerm is { type: string; value: string } {
  return (
    rdfTerm &&
    typeof rdfTerm === "object" &&
    rdfTerm.type === "uri" &&
    rdfTerm.value === URI_NOT_FOUND
  );
}
