import lunr from "lunr";
import { ReconcileResult } from "../../interfaces/ReconcileServiceIfc";
import { UriData, SearchMode } from "./types";
import logger from "../../../../utils/logger";

export class LunrSearchEngine {
  // Top result must be this much better (relatively) than the 2nd to be a definitive match
  private static MATCH_MIN_GAP = 0.3;

  constructor(
    private readonly index: lunr.Index,
    private readonly uriToData: Map<string, UriData>,
    private readonly fieldBoosts: Map<string, number>,
    private readonly maxResults: number,
  ) {}

  search(name: string, type?: string): ReconcileResult[] {
    const sanitized = this.sanitize(name);
    const { results: lunrResults, mode } = this.runCascade(sanitized);

    logger.info(
      {},
      `[lunr-recon] Lunr → ${lunrResults.length} result(s) for "${name}" (${mode})${type ? ` [type: ${type}]` : ""}`,
    );

    const filtered = type
      ? lunrResults.filter(
          (r) => this.uriToData.get(r.ref)?.types?.includes(type) ?? false,
        )
      : lunrResults;

    if (filtered.length === 0) return [];

    const maxScore = filtered[0].score;
    const isMatch = this.isConfidentMatch(filtered, mode);

    return filtered.slice(0, this.maxResults).map((r, i) => ({
      id: r.ref,
      name: this.uriToData.get(r.ref)?.label ?? r.ref,
      score: Math.round((r.score / maxScore) * 100),
      match: i === 0 && isMatch,
    }));
  }

  private sanitize(term: string): string {
    return term
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[+\-~^:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private runCascade(sanitized: string): {
    results: lunr.Index.Result[];
    mode: SearchMode;
  } {
    const tokens = sanitized.split(/\s+/).filter(Boolean);
    const fields = [...this.fieldBoosts.entries()];

    // 1. Wildcard suffix — best for partial/autocomplete input
    try {
      const results = this.index.query((q) => {
        for (const token of tokens)
          for (const [field, boost] of fields)
            q.term(token, {
              fields: [field],
              boost,
              wildcard: lunr.Query.wildcard.TRAILING,
            });
      });
      if (results.length > 0) return { results, mode: "wildcard" };
    } catch {}

    // 2. Fuzzy ~1 per token — handles single-char typos ("aspiryne" → "aspirine")
    try {
      const results = this.index.query((q) => {
        for (const token of tokens)
          for (const [field, boost] of fields)
            q.term(token, { fields: [field], boost, editDistance: 1 });
      });
      if (results.length > 0) return { results, mode: "fuzzy" };
    } catch {}

    // 3. Fuzzy ~2 for tokens ≥5 chars — handles combined typo+incomplete input
    //    ("aspiryn" → "aspirine": 2 edits: y→i + insert e)
    if (tokens.some((t) => t.length >= 5)) {
      try {
        const results = this.index.query((q) => {
          for (const token of tokens)
            for (const [field, boost] of fields)
              q.term(token, {
                fields: [field],
                boost,
                editDistance: token.length >= 5 ? 2 : 1,
              });
        });
        if (results.length > 0) return { results, mode: "fuzzy" };
      } catch {}
    }

    // 4. Exact — final fallback
    try {
      return {
        results: this.index.query((q) => {
          for (const token of tokens)
            for (const [field, boost] of fields)
              q.term(token, { fields: [field], boost });
        }),
        mode: "exact",
      };
    } catch {
      return { results: [], mode: "exact" };
    }
  }

  private isConfidentMatch(
    results: lunr.Index.Result[],
    mode: SearchMode,
  ): boolean {
    // Fuzzy results are inherently uncertain — never auto-accept
    if (mode === "fuzzy") return false;
    // Single result with no competition is always a confident match
    if (results.length === 1) return true;
    // Top result must be at least MATCH_MIN_GAP relatively better than the second
    const gap = (results[0].score - results[1].score) / results[0].score;
    return gap >= LunrSearchEngine.MATCH_MIN_GAP;
  }
}
