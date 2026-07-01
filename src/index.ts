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
export type { DeltaEngine, DeltaEngineConfig, SendInput, SendResult, InspectResult, ModelDef, ModelOptions } from "./engine";

// Shared domain types the developer encounters in send results, inspect results,
// and action context. Budget is expressed as Cost (the same multi-axis vector
// used for declarations and runtime measurements).
export type { Cost, Task, SupervisionPolicy, Memory } from "./shared/types";

// ── Adapters ──────────────────────────────────────────────────────────────────
// Storage adapters, reasoner adapters, and the Chat SDK channel bridge.
// Wire one of each into DeltaEngineConfig; defaults are in-memory + mock.
export { createInMemoryStore } from "./ports";
export { createDrizzleStore } from "./ports";
export { createMockReasoner } from "./ports";
export type { MockResponse, MockReasonerOptions } from "./ports";
export { createChatSdkChannel } from "./comms";
export type { ChatThread } from "./comms";

// ── Result utilities ──────────────────────────────────────────────────────────
// Re-export slang-ts so callers can construct Ok/Err, pattern-match results,
// and use safeTry without a separate slang-ts import.
export * from "slang-ts";
