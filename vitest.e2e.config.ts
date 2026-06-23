import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Load credentials from a gitignored .env (OPENROUTER_API_KEY, optional
 * OPENROUTER_MODEL / OPENROUTER_BASE_URL) so they never live in a committed file
 * or on the command line. A real environment variable always wins over .env.
 * Dependency-free on purpose: a single secret file does not justify a dotenv dep.
 */
const loadEnvFile = (): void => {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match === null) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
};

loadEnvFile();

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
