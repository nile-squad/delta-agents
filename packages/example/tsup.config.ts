/**
 * Build configuration for delta-agents-example.
 *
 * Mirrors the root delta-agents package's tsup config: this example must run
 * on plain Node (no Bun dependency) so a consumer without Bun installed can
 * still build and run it via `pnpm build && pnpm start`.
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  clean: true,
});
