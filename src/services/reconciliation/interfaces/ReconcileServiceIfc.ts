import { injectable } from "tsyringe";

export type SingleReconcileQuery = { query: string; type?: string };
export type ReconcileInput = Record<string, SingleReconcileQuery>;
export type ReconcileResultBase = {
  id: string;
  name: string;
  type?: string[];
  score: number;
  match: boolean;
};

export type ReconcileResultWithTypes = ReconcileResultBase & {
  type: Array<{ id: string; name: string }>;
};

export type ReconcileResult = ReconcileResultBase | ReconcileResultWithTypes;

export type ReconcileOutput = Record<string, { result: ReconcileResult[] }>;

/**
 * A service for reconciling named entities labels and returnning proposals for corresponding IRIs.
 */
export type ManifestType = {
  versions: string[];
  name: string;
  identifierSpace: string;
  schemaSpace: string;
  view: { url: string };
  defaultTypes: any[];
  types: any[];
  features: {
    "property-search": boolean;
    "type-search": boolean;
    preview: boolean;
    suggest: boolean;
  };
};

/**
 * A service for reconciling named entities labels and returnning proposals for corresponding IRIs.
 */
export interface ReconcileServiceIfc {
  reconcileQueries(
    queries: ReconcileInput,
    includeTypes: boolean,
  ): Promise<ReconcileOutput>;

  /**
   * Takes a complete parsed SparnaturalQuery, finds all URI_NOT_FOUND labels,
   * reconciles them, and injects the resolved URIs back into the query.
   * Mutates and returns the query.
   */
  resolveQueryUris(parsedQuery: any): Promise<any>;

  buildManifest(): Promise<ManifestType>;
}

@injectable({ token: "NoOpReconcileService" })
export class NoOpReconcileService implements ReconcileServiceIfc {
  reconcileQueries(
    queries: ReconcileInput,
    includeTypes: boolean,
  ): Promise<ReconcileOutput> {
    return Promise.resolve({});
  }

  resolveQueryUris(parsedQuery: any): Promise<any> {
    return Promise.resolve(parsedQuery);
  }

  buildManifest(): Promise<ManifestType> {
    throw new Error("Error: ReconcileService not configured");
  }
}
