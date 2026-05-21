import { ReconcileResult } from "../../interfaces/ReconcileServiceIfc";
import logger from "../../../../utils/logger";

export class ReconcileCache {
  private cache: Map<string, ReconcileResult[]> = new Map();

  constructor(private readonly maxSize: number) {}

  buildKey(name: string, type?: string, includeTypes?: boolean): string {
    return encodeURIComponent(
      name.toLowerCase() +
        (type ? `|${type}` : "") +
        (includeTypes ? "|openrefine" : "|simple"),
    );
  }

  get(cacheKey: string, includeTypes: boolean): ReconcileResult[] | null {
    const results = this.cache.get(cacheKey);
    if (!results) return null;
    if (includeTypes && !results[0]?.type) return null;
    // Re-insert to mark as recently used (LRU)
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, results);
    return results;
  }

  set(key: string, results: ReconcileResult[]): void {
    this.cache.delete(key);
    this.cache.set(key, results);
    if (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value!;
      this.cache.delete(oldestKey);
      logger.info({}, `[cache] LRU eviction: "${oldestKey}"`);
    }
  }
}
