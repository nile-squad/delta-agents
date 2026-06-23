# ADR-006: Runtime and Build Target

> **Status:** Accepted (2026-06-22). Supersedes the previous @nilejs/future Bun-only ADR, whose content is in git history.

## Context

The previous ADR mandated a Bun-only runtime because @nilejs/future relied on worker-thread actor isolation and SharedArrayBuffer, which needed Bun specifics. Delta-agents has a different architecture: the governance engine is stateless and deterministic, it holds no long-lived in-process actor state, and isolation is provided by the TaskID boundary and the storage port rather than by worker threads. The actor-isolation reason for Bun no longer applies.

Delta-agents also ships differently. It is an SDK-style library that a developer installs into an existing backend, not a standalone runtime. The dominant backend runtime for that audience is Node. Coupling the published artifact to Bun would shrink the addressable userbase for no architectural gain.

## Decision

1. **Target Node for the published artifact.** The library is built and published as Node-compatible ESM. Node is the supported runtime for consumers.
2. **Build with tsup (esbuild plus a declaration pass), not Bun.** The build script is `vitest run && tsc --noEmit && tsup`. There is no Bun step in the build.
3. **Bun remains optional for local development only.** Contributors may use Bun as a fast local runtime, but nothing in the build, test, or publish path requires it. The canonical test runner is vitest.

## Why a bundler is required

The source uses extensionless barrel imports (for example `import { runWorkflow } from "../workflow"`). Plain `tsc` cannot emit these as Node-resolvable ESM because Node ESM requires explicit file extensions, and `tsc` does not rewrite import specifiers. A CommonJS emit is not an option either, because several runtime dependencies (`nanoid` v5, `openai` v6) are ESM-only and cannot be loaded with `require`. A Node-native bundler resolves the barrel imports into a single Node-loadable ESM artifact. tsup was chosen over raw esbuild because it emits the `.d.ts` surface in the same pass.

## Consequences

- The published bundle is a single ESM file plus its type declarations. Runtime dependencies stay external (installed by the consumer's package manager) with one deliberate exception: `slang-ts` is bundled in, because the public entry re-exports it with `export *` and esbuild drops star re-exports of external packages. See context.md for the full reasoning.
- esbuild requires its platform binary, so its install script is approved in `pnpm-workspace.yaml`. pnpm v11 reads build-script approvals there, not from `package.json`.
- If a future feature needs true in-process actor isolation, this decision is revisited. For the current stateless engine it is not needed.

See [delta-agents.spec.md](../delta-agents.spec.md) for the canonical specification.
