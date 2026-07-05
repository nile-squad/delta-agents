/**
 * Public entry point for delta-agents.
 *
 * Import from this module (or from "delta-agents" when installed as a package)
 * to access the engine factory, authoring types, adapter factories, and the
 * result utilities the engine builds on. Internal governance machinery
 * (Kalman estimator, Bellman/MPC math, trust update internals, post-step
 * plumbing) is intentionally not exported. Those are implementation details
 * of the control plane, not the developer surface.
 */

// ── Authoring ─────────────────────────────────────────────────────────────────
// Types a developer writes against to define agents, actions, and workflows.
export type {
  Action,
  ActionContext,
  ActionFn,
  HookFn,
  Hooks,
  Branch,
  ActionRef,
  Phase,
  SupervisionPolicyDef,
  Workflow,
  Channel,
  ChannelType,
  Skill,
  DataSource,
  DataSourceOwnership,
  DataSourceAuthentication,
  Agent,
  ToolContext,
  ToolHistoryEntry,
  Tool,
} from "./authoring/types";

// ── Runtime ───────────────────────────────────────────────────────────────────
// The engine factory and the types that describe runtime state a developer
// reads back via inspect() / send() / resume().
export { createDeltaEngine } from "./engine";
export type { DeltaEngine, DeltaEngineConfig, SendInput, SendResult, InspectResult, ModelDef, ModelOptions, CleanupOptions, BuiltinToolsConfig, ToolsConfig, InvokeArgs } from "./engine";

// Builtin tool option types. Type-only re-export — erased at build, so it does
// not pull the document-extract module (or its optional peer deps) into the
// runtime graph of `import "delta-agents"`.
export type { DocumentExtractOptions } from "./tools/document-extract";
export type { WebSearchOptions } from "./tools/web-search";

// Shared domain types the developer encounters in send results, inspect results,
// and action context. Budget is expressed as Cost (the same multi-axis vector
// used for declarations and runtime measurements).
export type { Cost, Money, ContentCost, Task, SupervisionPolicy, Memory, Commit, CommitQuery, Attachment, AttachmentInput, RosterEntry, Message } from "./shared/types";

// Agent stats and workflow benchmarks: derived read-models from persisted data.
export type { AgentRanking, AgentStats, WorkflowStats } from "./engine/stats";

// ── Logger ────────────────────────────────────────────────────────────────────
// Per-engine logger configuration. The engine creates a default dev logger when
// none is configured; callers can override the mode, level, or drain.
export type { LoggerConfig, LoggerDrain, Logger, LogLevel, LogContext, LogEntry } from "./shared/logger-types";
export { createEngineLogger } from "./shared/logger";

// ── Adapters ──────────────────────────────────────────────────────────────────
// Storage adapters, reasoner adapters, and the Chat SDK channel bridge.
// Wire one of each into DeltaEngineConfig; defaults are in-memory + mock.
export { createInMemoryStore } from "./ports";
export { createDrizzleStore } from "./ports";
export { createMockReasoner } from "./ports";
export type { MockResponse, MockReasonerOptions } from "./ports";
export { createChatSdkChannel } from "./comms";
export type { ChatThread } from "./comms";

// Attachment loaders: convenience helpers to turn a local file or remote URL
// into an AttachmentInput for send(). Not required — attachments can be
// built by hand — but avoid repeating base64-encoding boilerplate.
export { loadAttachmentFromFile, loadAttachmentFromUrl } from "./shared/attachment-loader";

// Cache configuration for the read-through StoragePort wrapper. Forwarded to
// `DeltaEngineConfig.cache`. Omit to use defaults (1000 entries, 5-minute TTL).
export type { CacheConfig } from "./shared/cache";

// Per-module diagnostic toggles. Forwarded to `DeltaEngineConfig.diagnostics`.
// Omit (or pass `{}`) to disable all modules — disabled emission is provably
// zero overhead.
export type { DiagnosticsConfig } from "./shared/diagnostics";

// ── Events ─────────────────────────────────────────────────────────────────────
// Engine lifecycle events. Subscribe via `delta.events.on(eventName, handler)`
// to react to step-start, action-end, and other lifecycle moments.
export type { DeltaEventPayloads, DeltaEventName, DeltaEvents } from "./shared/create-events";

// ── Result utilities ──────────────────────────────────────────────────────────
// Re-export slang-ts so callers can construct Ok/Err, pattern-match results,
// and use safeTry without a separate slang-ts import.
export * from "slang-ts";
