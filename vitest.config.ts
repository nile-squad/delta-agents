import { defineConfig } from "vitest/config";

/**
 * Vitest is the single canonical test runner, running under Node (not bun).
 * The library targets the Node runtime, and the timer-mocking the suite relies
 * on (`vi.useFakeTimers` / `vi.runAllTimersAsync`) is a vitest feature bun's
 * runner does not implement — so tests are run with `vitest`, never `bun test`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts"],
    exclude: ["backup/**", "trash/**", "node_modules/**"],
  },
});
