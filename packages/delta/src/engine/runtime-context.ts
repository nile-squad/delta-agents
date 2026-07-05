/**
 * RuntimeContext — the engine-lifetime dependency bundle threaded through the
 * internal engine call chain (send loop, workflow driver, resume, scheduler,
 * step, commit step).
 *
 * WHY one bundle instead of ~10 loose params: these dependencies are built once
 * at `createDeltaEngine` time and never change for the life of the engine, yet
 * every hop of the call chain (runSendLoop → runScheduler → stepTask, plus
 * runWorkflowTask / resumeTask / runCommitStep) re-declared each of them as an
 * individual input field. Adding a single engine-lifetime dependency used to
 * mean editing 4+ signatures in lockstep. Bundling them into one immutable
 * object means a new dependency is added in exactly one place (this type) and
 * threaded automatically — per-call values (task, agent, reasoner, attachments,
 * startingSnapshot, …) stay separate params, unpacked from `runtime` only at the
 * module boundaries (workflow/execution/authoring) that keep explicit params.
 *
 * Internal only — never exported from `src/index.ts`.
 */

import type { StoragePort } from "../ports/storage-port";
import type { Registry } from "../authoring/registry";
import type { Logger } from "../shared/logger-types";
import type { Diagnostics } from "../shared/diagnostics";
import type { DeltaEventsInternal } from "../shared/create-events";
import type { RetryOptions } from "../infra";

export type RuntimeContext = {
  /** Cached read-through store handle (a StoragePort) built once by createCachedStore. */
  store: StoragePort;
  /** Authoring registry of agents/actions/workflows/tools. */
  registry: Registry;
  /** Per-engine pino-backed logger. */
  logger: Logger;
  /** Per-engine diagnostics handle (no-op for disabled modules). */
  diagnostics: Diagnostics;
  /** Per-engine events emitter — HITL and task lifecycle events fire through it. */
  events: DeltaEventsInternal;
  /** Reasoner-call resilience policy (merged over infra defaults at construction). */
  providerRetry: RetryOptions;
  /** Timezone for humanized time in reasoner messages; falls back to system tz downstream. */
  timezone?: string;
  /** Engine-lifetime numeric limits, defaulted once at construction. */
  limits: {
    /** Step ceiling per send/resume loop. */
    maxStepsPerTask: number;
    /** Max recent commits injected into reasoner context. */
    commitContextLimit?: number;
    /** Max consecutive invalid model decisions fed back before failing. */
    maxInvalidDecisionRetries: number;
  };
  /** Engine-lifetime feature flags. */
  flags: { guidanceEnabled: boolean };
};
