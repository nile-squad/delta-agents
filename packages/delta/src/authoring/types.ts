/**
 * Authoring API types — the shapes a developer touches.
 *
 * These are the definitions a developer writes. They describe what the engine
 * should be able to do, not what it is currently doing. The engine constructs
 * all runtime types (Task, Execution, Checkpoint, etc.) from these definitions.
 *
 * Every field here has a concrete reason grounded in the spec. If you add a
 * field, cite the spec section that requires it.
 */

import type { ZodObject, ZodRawShape } from "zod";
import type { Result } from "slang-ts";
import type { Attachment, Cost } from "../shared/types";

// Context injected into action fn, hooks, and branch guards at runtime.
// The engine assembles this — the developer never constructs it.
export type ActionContext = {
  taskId: string;
  executionId: string;
  agentName: string;
  phase?: string;
  /**
   * The workflow-level narrative arc, when running inside a workflow. Absent in
   * the free reasoner loop (no workflow context).
   */
  storyline?: string;
  /**
   * The current phase's narrative beat, when running inside a workflow. Absent
   * in the free reasoner loop.
   */
  phaseStoryline?: string;
  /**
   * Skills active at this action's invocation point. In the free reasoner loop
   * this is the agent's full skill set; in a workflow it is scoped to the action's
   * or phase's declared skills. Each entry's content is loaded from its SKILL.md.
   * Absent when no skills are active or the engine is running without a filesystem.
   */
  availableSkills?: Array<{ name: string; description: string; content?: string }>;
  /**
   * Send a message through one of the agent's bound channels, from inside an
   * action fn, hook, or workflow phase. Routes through the same governed dispatch
   * as the reasoner's `communicate` decision (resolves the channel, records a
   * TaskID-attributable Message). Returns Err for an unknown channel, a transport
   * failure, or a channel that requires approval (hooks never authorize — gate
   * such channels via the reasoner path instead). Absent when no agent context is
   * available (e.g. a standalone gateway call in a unit test).
   */
  communicate?: (channelType: string, body: string) => Promise<Result<unknown, string>>;
  /**
   * Persist a memory from inside an action fn, hook, or workflow phase. The memory
   * is owned by the agent and attributable to this task (invariant 8); a later
   * task by the same agent can retrieve it on demand (spec principle 4: memory is
   * retrieved, not carried). `kind` is a free-form label (default "note"). Absent
   * when no agent context is available (e.g. a standalone gateway call in a test).
   */
  remember?: (content: string, kind?: string) => Promise<Result<unknown, string>>;
};

// Every action fn and hook returns a Result. The engine never infers
// success from the absence of a throw (spec invariant 19, prohibition 18).
export type ActionFn<TInput extends Record<string, unknown>> = (
  input: TInput,
  ctx: ActionContext,
) => Promise<Result<unknown, string>>;

export type HookFn = (ctx: ActionContext) => Promise<Result<unknown, string>>;

// Hooks observe and prepare. They never authorize or bypass governance
// (spec §Lifecycle Hooks, invariant 22, prohibition 17).
export type Hooks = {
  before?: HookFn;
  after?: HookFn;
  onError?: HookFn;
};

/**
 * A single executable operation with its governance metadata.
 *
 * `risk` and `estimatedCost` are optional priors that seed the Kalman estimator.
 * Declaring them speeds up calibration and carries human judgement about
 * danger/irreversibility. They are never ceilings — the engine can and will
 * raise risk above the declared level based on evidence (spec §Anticipated Risk
 * and Cost, invariant 23, prohibition 20).
 *
 * `prerequisites` gate this action until named actions/workflows complete.
 * While unsatisfied, the action is not discoverable and cannot be authorised
 * (spec §Action Prerequisites, invariant 20, prohibition 16).
 */
export type Action<TInput extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  description: string;
  schema: ZodObject<ZodRawShape>;
  risk?: 1 | 2 | 3 | 4 | 5;
  estimatedCost?: Cost;
  requiresApproval?: boolean;
  prerequisites?: {
    actions?: string[];
    workflows?: string[];
  };
  hooks?: Hooks;
  fn: ActionFn<TInput>;
  /** Skills active only when this action runs (overrides phase-level skills). */
  skills?: (string | Skill)[];
  /** Advisory hint: tools useful for this action. All tools remain visible regardless. */
  tools?: string[];
};

/**
 * Context passed to a tool's execution function. Provides identifying
 * information for audit trails and access to prior tool history.
 */
export type ToolContext = {
  agentName: string;
  taskId: string;
  phaseName?: string;
  toolHistory: ToolHistoryEntry[];
  /** Attachments supplied at send() time — lets a tool look up raw content (e.g. a file to extract text from) by id. Absent or empty when the task carries none. */
  attachments?: Attachment[];
};

/**
 * A single tool execution record. Persisted in TaskStateSnapshot for
 * checkpointing and audit. Every tool call is logged with full context
 * for governance, provenance, and safety.
 */
export type ToolHistoryEntry = {
  id: string;
  toolName: string;
  input: unknown;
  output: unknown;
  truncated: boolean;
  timestamp: number;
  agentName: string;
  phaseName?: string;
  tokenCount?: number;
  cost?: Cost;
  /**
   * Full (untruncated) output, kept when the inline `output` was truncated for
   * history-size bounds. Allows `get_tool_history_entry` to return the complete
   * value on demand ("deep dive") without re-running the tool.
   */
  outputFull?: unknown;
};

/**
 * A reusable, stateless utility available to all agents. Unlike actions,
 * tools do not change state space, have no prerequisites, and carry no
 * risk. They provide reasoning context (web search, math, etc.).
 *
 * Tools are registered globally at the engine level and are always
 * visible to the model. Progressive disclosure keeps context small:
 * the model sees names + descriptions, schemas are fetched on demand.
 */
export type Tool = {
  name: string;
  description: string;
  schema: ZodObject<ZodRawShape>;
  skills?: (string | Skill)[];
  fn: (ctx: { data: unknown; ctx: ToolContext }) => Promise<Result<unknown, string>>;
  limits?: {
    maxCallsPerPhase?: number;
    maxCallsPerTask?: number;
    cooldownMs?: number;
  };
  cost?: Cost;
  budget?: Cost;
};

/**
 * A branch node in a phase's action list.
 *
 * Routes to the next action based on the prior action's Result outcome
 * or an optional guard evaluated against task state. The engine never
 * invents a transition not declared here (invariant 21, prohibition 19).
 */
export type Branch = {
  action: string;
  onSuccess?: string;
  onFailure?: string;
  when?: (ctx: ActionContext) => boolean;
};

// An action reference in a phase: plain string = sequential, Branch = conditional.
export type ActionRef = string | Branch;

/**
 * A stage of a workflow with its action list, checkpoint flag, and optional supervision.
 *
 * `checkpoint: true` means the engine writes a recoverable state boundary after
 * this phase completes (spec §Checkpointing).
 */
export type Phase = {
  name: string;
  description: string;
  actions: ActionRef[];
  checkpoint: boolean;
  supervision?: SupervisionPolicyDef;
  hooks?: Hooks;
  /** Skills active for all actions in this phase (overridable per-action via Action.skills). */
  skills?: (string | Skill)[];
  /**
   * Narrative of the ideal user flow for this phase — a beat within the
   * workflow's storyline arc. Guides action functions and hooks on how events
   * should unfold experientially.
   */
  storyline?: string;
  /** Advisory hint: tools useful in this phase. All tools remain visible regardless. */
  tools?: string[];
};

export type SupervisionPolicyDef = {
  strategy:
    | "retry"
    | "restart"
    | "resume"
    | "escalate"
    | "abort-subtree"
    | "abort-tree";
  maxRetries: number;
};

/**
 * An ordered set of phases describing a governed procedure.
 *
 * `estimatedCost` is a prior for the whole workflow, used to seed the Kalman
 * estimator before any phase runs (spec §Anticipated Risk and Cost).
 */
export type Workflow = {
  name: string;
  description: string;
  version: string;
  phases: Phase[];
  estimatedCost?: Cost;
  hooks?: Hooks;
  /**
   * Narrative of the ideal user flow for the whole workflow — the experiential
   * arc. Phase storylines are beats within this arc. Guides action functions
   * and hooks on how events should unfold experientially.
   */
  storyline?: string;
};

export type Skill = {
  name: string;
  description: string;
  /** Path to the skill's folder. Must contain a SKILL.md file to be usable. */
  folder: string;
};

/**
 * Who owns the data a DataSource reads and writes.
 *
 * "internal" — the system running the agent owns the store (its own database).
 * "external" — a third party owns it (a partner API, a customer system). The
 * distinction is recorded as audit metadata so an operator can see, per task,
 * whether the agent touched data outside its own trust boundary. It is
 * descriptive, not an automatic risk multiplier: each operation declares its
 * own `risk` (see ADR-007).
 */
export type DataSourceOwnership = "internal" | "external";

/**
 * A non-secret descriptor of how a DataSource's operations authenticate.
 *
 * The engine NEVER stores or transmits credentials. Each operation `fn` owns its
 * own secrets through its closure, exactly as a plain action's fn does. This
 * field records only the mechanism (for example "oauth2", "api-key", "iam") so
 * the authoring surface and audit trail can describe the integration without
 * holding a secret (ADR-007, AGENTS.md secrets posture).
 */
export type DataSourceAuthentication = {
  type: string;
};

/**
 * A named, owned bundle of governed CRUD operations over one data store.
 *
 * Each operation is a full {@link Action}: it carries a schema and flows through
 * the same execution gateway as any other action, so a data read or write is
 * governed identically (schema validation, legality, approval, budget, risk,
 * trust, audit). The spec's bare `Fn` per operation cannot be governed because
 * the gateway is schema-first (invariant 4), so each operation is promoted to an
 * Action (ADR-007).
 *
 * `contentType` is a free-form descriptor of the records the source holds (the
 * spec's `ContentTypes` is undefined and AGENTS.md bans enum). At least one
 * operation must be defined. An agent reaches a DataSource by listing it in
 * `dataSources`; the engine then exposes its operations as governed actions.
 */
export type DataSource = {
  name: string;
  description: string;
  ownership: DataSourceOwnership;
  contentType: string;
  authentication?: DataSourceAuthentication;
  actions: {
    retrieve?: Action;
    create?: Action;
    update?: Action;
    delete?: Action;
  };
};

/** The four CRUD slots a DataSource may define, in a fixed order for iteration. */
export const DATA_SOURCE_OPERATIONS = ["retrieve", "create", "update", "delete"] as const;

/** Collect the defined operations of a DataSource as a flat Action list. */
export const dataSourceActions = (dataSource: DataSource): Action[] =>
  DATA_SOURCE_OPERATIONS.map((op) => dataSource.actions[op]).filter(
    (action): action is Action => action !== undefined,
  );

// Outbound/inbound transports an agent may use. Covers the spec's original set
// plus the platforms the Chat SDK message layer bridges to. The engine treats
// the type only as a selector label; the transport lives behind sendMessage.
export type ChannelType =
  | "whatsapp"
  | "email"
  | "slack"
  | "sms"
  | "webhook"
  | "discord"
  | "telegram"
  | "teams"
  | "googlechat"
  | "github"
  | "linear";

export type Channel = {
  type: ChannelType;
  enabled: boolean;
  /**
   * When true, a message through this channel requires human sign-off before it
   * is sent — the same approval gate actions use, applied to outbound comms
   * (e.g. an agent emailing a customer). The engine blocks and records a pending
   * approval keyed to the channel until a human resolves it (spec §Human Oversight).
   */
  requiresApproval?: boolean;
  sendMessage: (message: string, ctx: ActionContext) => Promise<Result<unknown, string>>;
  retrieveMessages?: (ctx: ActionContext) => Promise<Result<unknown, string>>;
  replyMessage?: (id: string, message: string, ctx: ActionContext) => Promise<Result<unknown, string>>;
};

/**
 * A role with its allowed actions, workflows, skills, and channels.
 *
 * The agent definition determines what the engine exposes to the reasoner
 * (via contextual action discovery) and what the engine can authorise
 * (via the execution gateway). Nothing outside this set is reachable.
 */
export type Agent = {
  name: string;
  description: string;
  role: string;
  rolePrompt: string;
  model?: string;
  contextWindow?: number;
  actions: Action[];
  workflows?: Workflow[];
  skills?: Skill[];
  channels?: Channel[];
  /**
   * Data stores this agent may read from and write to. The engine flattens each
   * DataSource's defined operations into the agent's reachable action set, so a
   * data operation is discovered and governed exactly like any other action.
   */
  dataSources?: DataSource[];
  team?: string;
};
