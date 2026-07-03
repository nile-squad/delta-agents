/**
 * Build configuration for delta-agents.
 *
 * WHY tsup (not Bun): delta-agents ships as a library installed into a Node
 * backend, so the build must run on Node toolchain alone with no Bun dependency.
 * tsup (esbuild + a declaration pass) bundles the extensionless barrel imports
 * the source uses into a single Node-resolvable ESM artifact, and emits the
 * .d.ts surface in the same step.
 *
 * Runtime dependencies stay external (tsup externalizes everything in
 * dependencies/peerDependencies by default): the consumer's package manager
 * installs them, so they are not duplicated into the bundle.
 *
 * slang-ts is the deliberate exception (noExternal). The public entry re-exports
 * it with `export * from "slang-ts"` so callers get Ok/Err/Result/safeTry from
 * "delta-agents" directly. esbuild silently drops a star re-export of an external
 * package (it cannot enumerate the names at build time), which would ship a
 * broken public surface. Bundling slang-ts in resolves the star at build time.
 * It is tiny and its Result is structural (no instanceof), so a consumer's own
 * slang-ts copy interoperates with the bundled one without identity issues.
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  dts: true,
  platform: "node",
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: ["slang-ts"],
});
