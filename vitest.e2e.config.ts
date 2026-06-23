import { defineConfig } from "vitest/config";

/**
 * End-to-end config: runs the tests under tests/e2e against the BUILT artifact
 * in dist/ (not src/), one suite per core principle. The live-model suites call
 * a real OpenAI-compatible endpoint (OpenRouter) and are skipped automatically
 * when OPENROUTER_API_KEY is not set; the deterministic suites run regardless.
 *
 * Run with `pnpm test:e2e` (which bundles dist first). Provide credentials on
 * the command line, never in a committed file:
 *   OPENROUTER_API_KEY=sk-or-... pnpm test:e2e
 *
 * Network round-trips to a real model are slow, so the per-test timeout is
 * raised well above the unit default.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Live-model calls share a rate limit; run the files sequentially.
    fileParallelism: false,
  },
});
