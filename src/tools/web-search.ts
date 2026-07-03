/**
 * Builtin tool: web search for grounding, via Exa.
 *
 * Gives an agent (or a developer, through delta.tools.invoke) current web
 * results for a query — title, url, and query-relevant highlights — so responses
 * can be grounded in live sources instead of the model's training cutoff.
 *
 * WHY a factory that lazily imports exa-js: like document-extract, this tool's
 * dependency (exa-js) is an optional peer dependency. A consumer who never opts
 * into web search must never load it. The factory is only reached through a
 * dynamic import in create-delta-engine, gated on `builtinTools.webSearch` being
 * set. The factory then imports exa-js dynamically and constructs the Exa client
 * up front, so a missing dependency OR a missing API key fails fast at engine
 * construction (an actionable setup error) rather than mid-task.
 *
 * WHY the API key is required and explicit: enabling web search means passing
 * `webSearch: { apiKey }`. The key is required at the type level (a caller cannot
 * enable the tool without one) and re-checked at runtime — the library never
 * silently falls back to an EXA_API_KEY environment variable, so the credential
 * a search runs under is always the one the caller declared.
 *
 * Scope: fixed to type "auto" (balanced relevance/speed) with highlights content
 * — the token-efficient excerpt mode that suits LLM grounding. maxResults is the
 * only search knob exposed.
 */

import { z } from "zod";
import { Ok, Err, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import type { Tool } from "../authoring/types";

/** Options for the web-search builtin tool. `apiKey` is required. */
export type WebSearchOptions = {
  /** Exa API key. Required — the tool never reads it from the environment. */
  apiKey: string;
  /** Maximum number of results to return. Default 10. */
  maxResults?: number;
};

const MISSING_DEP_HINT = "builtinTools.webSearch requires the exa-js peer dependency — install it: pnpm add exa-js";

// Minimal structural shape for the slice of the exa-js API this tool uses. The
// package is an optional peer dep loaded at runtime, so we type the dynamic
// surface locally rather than depend on its types at build.
type ExaSearchResult = { title?: string | null; url: string; highlights?: string[] };
type ExaClient = {
  search: (
    query: string,
    options: { type: "auto"; numResults: number; contents: { highlights: true } },
  ) => Promise<{ results: ExaSearchResult[] }>;
};
type ExaCtor = new (apiKey?: string) => ExaClient;

/**
 * Build the web-search tool. Async: it dynamically imports exa-js (throwing an
 * install hint if absent). The API key is required — a missing key throws at
 * construction rather than deferring to any environment fallback. The Exa client
 * is built eagerly and closed over so the tool fn reuses it.
 */
export const createWebSearchTool = async (options: WebSearchOptions): Promise<Tool> => {
  const maxResults = options.maxResults ?? 10;

  // Require an explicit key. Guard at runtime too (a JS caller could bypass the
  // type), and never let the Exa client fall back to EXA_API_KEY.
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new Error("builtinTools.webSearch requires an explicit apiKey — set tools.builtin.webSearch.apiKey");
  }

  const exaMod = await safeTry(async () => import("exa-js"));
  if (exaMod.isErr) throw new Error(MISSING_DEP_HINT);
  const Exa = (exaMod.value as { default: ExaCtor }).default;

  const clientResult = await safeTry(async () => new Exa(options.apiKey));
  if (clientResult.isErr) {
    throw new Error(`builtinTools.webSearch: could not initialize the Exa client — ${clientResult.error}`);
  }
  const client = clientResult.value;

  return {
    name: "web-search",
    description:
      "Search the web for current information to ground a response in live sources. " +
      "Returns the top results as title, url, and query-relevant highlights.",
    schema: z.object({ query: z.string() }),
    fn: async ({ data }: { data: unknown }): Promise<Result<unknown, string>> => {
      const { query } = data as { query: string };

      const searchRes = await safeTry(async () =>
        // Exa's own parameter is `numResults`; our public option is maxResults.
        client.search(query, { type: "auto", numResults: maxResults, contents: { highlights: true } }),
      );
      if (searchRes.isErr) return Err(`web-search: search failed — ${searchRes.error}`);

      const results = searchRes.value.results;
      if (results.length === 0) return Err(`web-search: no results for "${query}"`);

      // One block per result: title, url, then highlights joined. Plain text so
      // the model reads it directly (same contract as document-extract).
      const formatted = results
        .map((r) => {
          const title = r.title ?? "(untitled)";
          const highlights = (r.highlights ?? []).join(" … ");
          return highlights.length > 0 ? `${title}\n${r.url}\n${highlights}` : `${title}\n${r.url}`;
        })
        .join("\n\n");
      return Ok(formatted);
    },
  };
};
