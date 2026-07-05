/**
 * Engine assembly types.
 *
 * DeltaEngineConfig carries the adapters and limits that shape engine behaviour
 * at construction time. Defaults keep the engine fully functional with no
 * external dependencies so tests never need to wire up real storage or model APIs.
 *
 * DeltaEngine is the single facade the developer interacts with — authoring methods
 * define capabilities, runtime methods drive execution. The internals stay decoupled;
 * only the facade is unified (spec §Delta DX, context.md §DX Pattern).
 */

import type { Result } from "slang-ts";
import type { Cost, Task, Execution, Checkpoint, ApprovalRequest, EscalationRecord, AttachmentInput, Message } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort } from "../ports/reasoner-port";
import type { RetryOptions } from "../infra";
import type { Action, Workflow, Agent, DataSource, Tool, ToolContext } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { LoggerConfig } from "../shared/logger-types";
import type { CacheConfig } from "../shared/cache";
import type { CleanupOptions } from "./cleanup";
import type { DiagnosticsConfig } from "../shared/diagnostics";
import type { RosterEntry } from "./roster";
import type { AgentRanking, AgentStats, WorkflowStats } from "./stats";
// Type-only import: referencing DocumentExtractOptions as a type must NOT create
// a static runtime import of the document-extract module (which loads the heavy
// optional peer deps). Type-only imports are erased at build.
import type { DocumentExtractOptions } from "../tools/document-extract";
import type { WebSearchOptions } from "../tools/web-search";

/**
 * Opt-in configuration for framework-provided (builtin) tools. Declaring a
 * builtin registers it at construction time (globally visible to every agent)
 * and lazily loads its optional peer dependencies. A builtin left undeclared is
 * never registered and its peer deps are never loaded.
 */
export type BuiltinToolsConfig = {
  /**
   * Register the document-extract tool (file/image → text via liteparse + OCR).
   * `true` uses defaults; an options object overrides them. Requires the
   * @llamaindex/liteparse and sharp optional peer dependencies to be installed.
   */
  documentExtract?: boolean | DocumentExtractOptions;
  /**
   * Register the web-search tool (Exa) for grounding. Must be an options object
   * with an explicit `apiKey` (required — never read from the environment);
   * `maxResults` is optional. Requires the exa-js optional peer dependency.
   * Throws at construction if the key is missing.
   */
  webSearch?: WebSearchOptions;
};

/**
 * All tools an engine exposes, declared in one place at engine definition
 * (rather than registered piecemeal across application code). `builtin` turns on
 * framework-provided tools; `custom` supplies developer-authored `Tool` objects.
 * Every tool declared here — builtin or custom — is global, agent-visible, and
 * invokable through `delta.tools.invoke`.
 */
export type ToolsConfig = {
  /** Framework-provided tools to turn on. */
  builtin?: BuiltinToolsConfig;
  /** Developer-authored tools. Validated and registered at construction time. */
  custom?: Tool[];
};

/**
 * Provider options forwarded verbatim to the model API each call.
 * Omit a field to use the provider's default (e.g. omit temperature for o-series
 * reasoning models that reject it). Per-model options override engine-level ones.
 */
export type ModelOptions = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
};

/**
 * A named model configuration the engine can route agents to.
 *
 * `name` is the identifier agents reference via `agent.model`. `model` is the
 * model ID sent to the provider (e.g. "gpt-4o"). `endpoint` and `apiKey` override
 * engine-level defaults — useful for mixing providers (OpenAI + OpenRouter +
 * a local Ollama instance) in one engine. `options` are forwarded to the provider
 * and merged over the engine-level `options`.
 */
export type ModelDef = {
  name: string;
  model: string;
  /** Mark this as the engine default. Agents that omit `model` use this one. Exactly one must be true. */
  default?: boolean;
  /** Per-model base URL override. Falls back to the engine-level `endpoint`. */
  endpoint?: string;
  /** Per-model API key override. Falls back to the engine-level `apiKey`. */
  apiKey?: string;
  /** Per-model provider options. Merged over engine-level `options` (per-model wins). */
  options?: ModelOptions;
  /**
   * Declares this model can accept image content in the chat request (vision).
   * When an agent's resolved model does not declare `vision: true`, `send()`
   * rejects any `kind: "image"` attachment before creating a task (fail-fast —
   * no silent degrade). Defaults to false/undefined.
   */
  vision?: boolean;
  /**
   * Declares this model can accept audio content in the chat request. When an
   * agent's resolved model does not declare `audio: true`, `send()` rejects any
   * `kind: "audio"` attachment before creating a task (fail-fast — no silent
   * degrade), the same way `vision` gates image attachments. Defaults to
   * false/undefined.
   */
  audio?: boolean;
};

export type DeltaEngineConfig = {
  /** Persistence adapter. Defaults to an isolated in-memory store. */
  store?: StoragePort;
  /**
   * Default base URL for all model API calls (OpenAI-compatible).
   * Per-model `endpoint` overrides this. Defaults to the OpenAI endpoint.
   */
  endpoint?: string;
  /**
   * Default API key for all model API calls.
   * Per-model `apiKey` overrides this.
   */
  apiKey?: string;
  /**
   * Default provider options applied to every model call.
   * Per-model `options` override these on a per-field basis.
   */
  options?: ModelOptions;
  /**
   * Named model definitions. At least one must carry `default: true` — that model
   * is used for agents that do not specify a model. Agent model names are validated
   * against this list at `delta.agent()` time (an unknown name throws immediately).
   *
   * When omitted, the engine falls back to the `reasoner` override (useful for
   * testing with a mock reasoner without configuring real model access).
   */
  models?: ModelDef[];
  /**
   * Reasoning adapter override. When set, bypasses the models config entirely and
   * uses this single adapter for all agents. Intended for testing — inject a mock
   * reasoner here; normal production usage goes through `models`.
   */
  reasoner?: ReasonerPort;
  /**
   * Maximum reasoner iterations per task.
   * Prevents an unbounded reasoning loop from running forever.
   * Default: 100.
   */
  maxStepsPerTask?: number;
  /**
   * Resilience for the reasoner boundary. A model call can fail in many ways:
   * a network error, a maxed-out usage/rate limit, malformed JSON, or simply not
   * calling a tool. Each reasoner step is retried with jittered exponential
   * backoff up to `maxAttempts`; when retries are exhausted the task escalates to
   * a human (a `reasoner-failure` escalation, task paused and resumable) rather
   * than failing outright (principle 8: human oversight is fundamental).
   * Partial overrides merge over the defaults (3 attempts, 200ms base, 5s cap).
   */
  providerRetry?: Partial<RetryOptions>;
  /**
   * Global org instructions passed to all agents. Static content baked into the
   * system message prefix for prompt cache hits. Must NOT contain time or varying
   * content — anything that changes per call breaks the cacheable prefix.
   */
  systemPrompt?: string;
  /**
   * Timezone for humanized time in reasoner messages (e.g. "Africa/Lagos").
   * Defaults to the system timezone. Grounds agents with time awareness.
   */
  timezone?: string;
  /**
   * Per-engine logger configuration. When omitted, the engine creates a dev
   * logger that writes colorized pino-pretty output to the console at info
   * level. Each engine gets its own logger; engines never share one.
   */
  logger?: LoggerConfig;
  /**
   * Read-through cache tuning. When set, the engine wraps the configured
   * `store` (or the default in-memory store) in a read-through cache that
   * accelerates hot-path reads (`getTask`, `getLatestCheckpoint`,
   * `getMemoriesByAgent`) and invalidates on writes. Omit to use defaults
   * (1000 entries, 5-minute sliding window).
   */
  cache?: CacheConfig;
  /**
   * Per-module diagnostic toggles. Each module can opt in to structured
   * event emission (timing, decision traces, counts) to the per-engine
   * logger at debug/trace level. Omit to disable all modules — the
   * disabled path is provably zero overhead (the module never touches the
   * logger). See `DiagnosticsConfig` for the supported module names.
   */
  diagnostics?: DiagnosticsConfig;
  /**
   * Number of recent commits to load into the agent's context on each
   * reasoner turn. Default 10. The agent can search for older commits
   * on demand via the system:search_commits tool (Phase 5).
   */
  commitContextLimit?: number;
  /**
   * Maximum reasoner attempts in the post-workflow commit step before
   * auto-committing with no notes. Default 3.
   */
  commitMaxRetries?: number;
  /**
   * Max consecutive invalid model decisions (unknown action / schema-invalid
   * input) fed back to the model for correction before the task fails.
   * Default 3. 0 = fail immediately (old behavior).
   */
  maxInvalidDecisionRetries?: number;
  /**
   * All tools this engine exposes — builtin (framework-provided, opt-in) and
   * custom (developer-authored) — declared in one place. Omit to expose none.
   * A builtin left undeclared loads none of its optional peer dependencies.
   */
  tools?: ToolsConfig;
  /**
   * Agent mailbox tuning. `inboxCap` bounds how many non-recalled messages an
   * agent's inbox retains; once exceeded, the oldest READ messages are evicted
   * first (unread messages are never dropped). Omit to leave inboxes unbounded.
   */
  mailbox?: { inboxCap?: number };
  /**
   * Engine-generated guidance. When `true` (default), the engine computes
   * warning-band advisory lines (risk, trust, budget, surprise) that reach the
   * model on its next turn so it can self-correct before escalation thresholds
   * fire. Set to `false` to disable guidance entirely.
   */
  guidance?: boolean;
};

export type SendInput = {
  goal: string;
  agentName: string;
  /** Budget ceiling for this task. Defaults to { tokens: 10_000, durationMs: 300_000 }. */
  budget?: Cost;
  /**
   * Name of a workflow the agent declares. When set, the task runs
   * deterministically through the workflow engine (phases in declared order)
   * instead of the free reasoner loop (the C-a coexistence model: a task with an
   * assigned workflow is reasoner-less; workflow-less tasks use the reasoner).
   * The agent must declare the workflow or the send fails.
   */
  workflow?: string;
  /**
   * Shared input bag handed to every action in the workflow run. Each action's
   * schema validates the subset it needs (the gateway rejects anything invalid).
   * Per-action reasoner-filled inputs are a future refinement; for now a single
   * bag covers the deterministic-workflow case. Ignored for the reasoner loop.
   */
  input?: Record<string, string | number | boolean | null>;
  /**
   * Per-action input overrides for a deterministic workflow run, keyed by action
   * name. When an action name is present here, its bag is used instead of the
   * shared `input` bag; absent action names fall back to `input`. Ignored for the
   * reasoner loop. (Reasoner-filled inputs remain a separate, future path.)
   */
  actionInputs?: Record<string, Record<string, string | number | boolean | null>>;
  /**
   * Images or files the agent should have access to for this task. `kind: "image"`
   * attachments are embedded as real vision content in the reasoner call when the
   * resolved model declares `vision: true` (send() rejects them otherwise, before
   * any task is created). `kind: "file"` attachments are never sent as raw bytes
   * to the model — they persist on the task, referenceable by id, for a future
   * extraction tool to read via `ToolContext.attachments`.
   */
  attachments?: AttachmentInput[];
};

export type SendResult = {
  taskId: string;
  /**
   * completed — all actions ran. blocked — waiting on a human decision.
   * failed — non-recoverable. queued — agent was busy, so the inbound goal was
   * attached as a message to its existing task and no new task was created
   * (spec §No New Task When Work Is Pending; taskId is the existing task's id).
   */
  status: "completed" | "failed" | "blocked" | "queued" | "pendingCommit";
  snapshot: TaskStateSnapshot;
  /** Populated when status is "blocked", "failed", or "queued". */
  reason?: string;
};

export type InspectResult = {
  /** Current task record — status, budget, risk, trust. */
  task: Task;
  /** All execution records for the task in creation order. */
  executions: Execution[];
  /** Latest recoverable state boundary, or null if no checkpoint exists yet. */
  latestCheckpoint: Checkpoint | null;
  /** All escalation events raised during the task's lifetime (invariant 13). */
  escalations: EscalationRecord[];
  /** Approvals waiting for a human decision. */
  pendingApprovals: ApprovalRequest[];
};

export type DeltaEngine = {
  // ── Authoring methods (define capabilities) ────────────────────────────────
  /** Define an executable operation. Validated and registered immediately. */
  action: <TInput extends Record<string, unknown>>(def: Action<TInput>) => Action<TInput>;
  /** Define an ordered procedure composed of phases (plain objects conforming to Phase). */
  workflow: (def: Workflow) => Workflow;
  /** Define a named, owned store of governed CRUD operations. */
  dataSource: (def: DataSource) => DataSource;
  /** Define a role with its allowed actions, workflows, and data sources. */
  agent: (def: Agent) => Agent;

  // ── Runtime methods (drive execution) ─────────────────────────────────────
  /** Mark a defined agent as active. The agent must already be registered via delta.agent(). */
  deploy: (agent: Agent) => void;
  /**
   * Hand a goal to a named agent and drive execution to completion (or until blocked).
   * Creates a new TaskID, runs the reasoner loop, and returns the terminal result.
   * If the agent is already busy, no new task is created: the goal is queued as a
   * message on its existing task and the result status is "queued" (invariant 26).
   * Returns Err only when the agent is unknown or persistence fails.
   */
  send: (input: SendInput) => Promise<Result<SendResult, string>>;
  /**
   * Approve a pending human approval request.
   * After approving, call resume(taskId) to continue a blocked task.
   */
  approve: (approvalId: string) => Promise<Result<ApprovalRequest, string>>;
  /**
   * Reject a pending human approval request.
   * The (taskId, action) pair stays permanently closed: the engine never
   * re-opens a rejected approval (spec §Human Oversight, prohibition 11).
   * `reason` is the reviewer's stated ground — persisted on the record and fed
   * back to the model on resume so it can route around the rejection (a free
   * loop chooses a different approach; a workflow fails honestly).
   */
  reject: (approvalId: string, reason?: string) => Promise<Result<ApprovalRequest, string>>;
  /** Suspend a task and save its current state as a checkpoint. */
  pause: (taskId: string) => Promise<Result<void, string>>;
  /**
   * Resume a paused or blocked task from its latest checkpoint.
   * Runs the reasoner loop from the saved state.
   */
  resume: (taskId: string) => Promise<Result<SendResult, string>>;
  /**
   * Read the full governance state for a task: task record, executions,
   * latest checkpoint, escalations, and pending approvals.
   * All entries are TaskID-attributable (invariants 1, 8, 9, 13).
   */
  inspect: (taskId: string) => Promise<Result<InspectResult, string>>;
  /**
   * Return the most recent task for a named agent.
   * An agent always has a retrieval path to its latest task without requiring
   * the caller to store the TaskID (invariant 25).
   */
  lastTask: (agentName: string) => Promise<Result<Task | null, string>>;
  /**
   * Team-awareness read-model: who is doing what, and how loaded each agent is
   * (major task + active subtasks + queued backlog). Derived from live task
   * state, so it is always consistent and needs no separate bookkeeping. Pass
   * `{ team }` to scope to one team; omit to list every registered agent. The
   * same data is surfaced to agents in their reasoning context to guide
   * delegation and mentions (avoid overloaded teammates).
   */
  roster: (query?: { team?: string }) => Promise<Result<RosterEntry[], string>>;

  /**
   * Top agents by completedTasks, successRate, or trustScore.
   * Includes all deployed agents with sorted rankings and optional limit.
   */
  topAgents: (args: { by: "completedTasks" | "successRate" | "trustScore"; limit?: number }) => Promise<Result<AgentRanking[], string>>;
  /**
   * Performance metrics for a single agent: success rate, cost, and trust trajectory.
   * Unknown agent returns zero-valued stats, not an error.
   */
  agentStats: (args: { agent: string }) => Promise<Result<AgentStats, string>>;
  /**
   * Workflow benchmark stats: runs, success rate, cost, and per-phase durations.
   * Unknown workflow returns zero-valued stats, not an error.
   */
  workflowStats: (args: { workflow: string }) => Promise<Result<WorkflowStats, string>>;

  // ── Mailbox (inbox / outbox / recall) ──────────────────────────────────────
  /**
   * An agent's inbox: messages addressed to it, unread first then oldest-first,
   * with recalled messages excluded. Each message carries its read receipt
   * (`readAt`) and delivery time. Reading the inbox also enforces the configured
   * `mailbox.inboxCap` (evicting oldest read messages).
   */
  inbox: (args: { agent: string }) => Promise<Result<Message[], string>>;
  /**
   * An agent's outbox: messages it sent, newest first, including recalled ones.
   * Read receipts are visible here (`readAt` set once the recipient read it), so
   * a sender can see whether — and when — a message was read.
   */
  outbox: (args: { agent: string }) => Promise<Result<Message[], string>>;
  /**
   * Recall (unsend) a message the agent sent, allowed only while it is still
   * unread. Returns the updated (recalled) message, or Err if it was already read,
   * already recalled, or not found.
   */
  recall: (args: { messageId: string }) => Promise<Result<Message, string>>;
  /**
   * Manually prune completed/failed tasks and consumed messages past their
   * retention windows, and evict expired cache entries. Destructive store
   * operations are opt-in via `CleanupOptions` — omit retention params to skip.
   * Cache eviction runs by default; pass `evictCache: false` to disable.
   */
  cleanup: (options?: CleanupOptions) => Promise<Result<void, string>>;

  // ── Tools ──────────────────────────────────────────────────────────────────
  /**
   * Direct, developer-facing invocation for any registered tool (builtin or
   * custom). Validates the input against the tool's schema and runs it with a
   * synthesized context. Unlike an agent's `system:use_tool` path, this does not
   * record tool history or apply loop/budget governance — it is an out-of-band
   * call with no task to govern. The call shape is identical for every tool:
   * `{ tool, input, ctx? }`.
   */
  tools: {
    invoke: (args: InvokeArgs) => Promise<Result<unknown, string>>;
  };
};

/** Named arguments for `delta.tools.invoke` — a uniform shape across all tools. */
export type InvokeArgs = {
  /** Registered name of the tool to invoke. */
  tool: string;
  /** Input for the tool, validated against its schema. */
  input: unknown;
  /**
   * Optional tool context. Most callers supply only `attachments`; identity
   * fields (`agentName`, `taskId`) default to standalone-call placeholders.
   */
  ctx?: Partial<ToolContext>;
};
