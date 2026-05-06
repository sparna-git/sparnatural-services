import {
  ManifestType,
  ReconcileInput,
  ReconcileOutput,
  ReconcileServiceIfc,
} from "./ReconcileServiceIfc";
import {
  collectUnresolvedLabels as collectOld,
  buildLabelToUriMap as buildOld,
  injectResolvedUris as injectOld,
} from "../utils/UriReconciliationHelperOld";
import {
  collectUnresolvedLabels as collectV13,
  buildLabelToUriMap as buildV13,
  injectResolvedUris as injectV13,
} from "../utils/UriReconciliationHelperV13";

/**
 * Tries each service in order for every reconcile query.
 * The first service that returns at least one result wins; remaining services are skipped.
 * If all services return empty for a given key, an empty result is returned for that key.
 */
export class ChainedReconcileService implements ReconcileServiceIfc {
  constructor(private readonly services: ReconcileServiceIfc[]) {}

  async reconcileQueries(
    queries: ReconcileInput,
    includeTypes: boolean,
  ): Promise<ReconcileOutput> {
    const output: ReconcileOutput = {};

    for (const [key, qobj] of Object.entries(queries)) {
      let resolved = false;
      for (const service of this.services) {
        const result = await service.reconcileQueries({ [key]: qobj }, includeTypes);
        if (result[key]?.result?.length > 0) {
          output[key] = result[key];
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        output[key] = { result: [] };
      }
    }

    return output;
  }

  async resolveQueryUris(parsedQuery: any): Promise<any> {
    const isV13 = !!parsedQuery?.where?.predicateObjectPairs;
    const collectFn = isV13 ? collectV13 : collectOld;
    const buildFn = isV13 ? buildV13 : buildOld;
    const injectFn = isV13 ? injectV13 : injectOld;

    const labelsToResolve = collectFn(parsedQuery);

    if (Object.keys(labelsToResolve).length === 0) {
      console.log("[chained-reconciliation] ✅ No URI_NOT_FOUND labels to resolve.");
      return parsedQuery;
    }

    console.log(
      `[chained-reconciliation] 🔎 Resolving ${Object.keys(labelsToResolve).length} label(s):`,
      Object.values(labelsToResolve).map((l) => l.query),
    );

    const uriRes = await this.reconcileQueries(labelsToResolve, false);
    const labelToUri = buildFn(labelsToResolve, uriRes);
    injectFn(parsedQuery, labelToUri);

    return parsedQuery;
  }

  async buildManifest(): Promise<ManifestType> {
    return this.services[0].buildManifest();
  }
}
