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
import type { Cost } from "../shared/types";

// Context injected into action fn, hooks, and branch guards at runtime.
// The engine assembles this — the developer never constructs it.
export type ActionContext = {
  taskId: string;
  executionId: string;
  agentName: string;
  phase?: string;
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
};

export type Skill = {
  name: string;
  description: string;
  path: string;
  active: boolean;
};

export type ChannelType =
  | "whatsapp"
  | "email"
  | "slack"
  | "sms"
  | "webhook";

export type Channel = {
  type: ChannelType;
  enabled: boolean;
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
  team?: string;
};
