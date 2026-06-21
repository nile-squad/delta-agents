/**
 * Memory relevance ranking — pure function.
 *
 * Spec principle 4 ("memory is retrieved, not carried") needs a relevance signal
 * so the engine surfaces the *useful* memories, not all of them. Semantic ranking
 * (embeddings + cosine) is the eventual goal but needs an embedding provider the
 * library does not assume; this is the no-dependency default: keyword overlap with
 * the query, breaking ties toward recency.
 *
 * Inputs are assumed most-recent-first (as getMemoriesByAgent returns them), so a
 * lower index means newer — the tiebreak prefers newer memories.
 */

import type { Memory } from "../shared/types";

/** Lowercase alphanumeric tokens, for keyword-overlap scoring. */
const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Rank memories by keyword overlap with `query`, recency-breaking ties, and
 * return the top `limit`. With no query tokens (or no overlap) it degrades
 * gracefully to "most recent first", which is a sensible context default.
 */
export const rankMemories = ({
  memories,
  query,
  limit,
}: {
  memories: Memory[];
  query: string;
  limit: number;
}): Memory[] => {
  const queryTokens = new Set(tokenize(query));
  const scored = memories.map((memory, index) => {
    const overlap = tokenize(memory.content).reduce((n, t) => n + (queryTokens.has(t) ? 1 : 0), 0);
    return { memory, overlap, recencyIndex: index };
  });
  scored.sort((a, b) => b.overlap - a.overlap || a.recencyIndex - b.recencyIndex);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.memory);
};
