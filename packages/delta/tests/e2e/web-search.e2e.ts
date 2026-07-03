/**
 * web-search builtin tool — live end-to-end against the real Exa API.
 *
 * Imports the BUILT artifact (../../dist/index.js), like the other e2e suites,
 * so it exercises the shipped package. Skipped automatically when EXA_API_KEY is
 * not set (loaded from a gitignored .env by vitest.e2e.config.ts), so the suite
 * stays green with no credentials.
 *
 * Run: EXA_API_KEY=... pnpm test:e2e
 */

import { describe, it, expect } from "vitest";
import { createDeltaEngine } from "../../dist/index.js";

const EXA_KEY = process.env.EXA_API_KEY;
const describeLive = EXA_KEY ? describe : describe.skip;

describeLive("web-search (live Exa)", () => {
  it("returns grounded results for a query", async () => {
    const delta = await createDeltaEngine({
      tools: { builtin: { webSearch: { apiKey: EXA_KEY, maxResults: 5 } } },
    });
    const res = await delta.tools.invoke({
      tool: "web-search",
      input: { query: "latest developments in AI safety research" },
    });
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      const text = String(res.value);
      // Formatted results carry at least one URL.
      expect(text).toMatch(/https?:\/\//);
      expect(text.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
