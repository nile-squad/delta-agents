/**
 * Core shared types for the delta-agents runtime.
 *
 * These types are the data layer referenced by every domain module.
 * Authoring types (Action, Workflow, Phase, Agent) live in src/authoring/types.ts.
 * Runtime types here are owned and constructed by the engine — never by the developer.
 */

// A recursive JSON-serializable value. Used instead of `unknown` to keep
// the type system honest while still permitting dynamic structured data
// (checkpoint state, message payloads).
export type Json = string | number | boolean | null | Json[] | JsonRecord;
export type JsonRecord = { [key: string]: Json };

// Resource consumption for a task or action execution — a multi-axis vector.
// Cost is more than tokens and time: memory and latency are first-class axes so
// the engine can budget, project (MPC), and scope them like any other resource.
//   tokens     — model token usage (the primary governance currency).
//   durationMs — wall-clock execution time of the work itself.
//   memory     — memory footprint (developer-chosen unit, e.g. bytes/MB). Optional.
//   latency    — added delay beyond execution time, e.g. a comms round-trip. Optional.
//   money      — financial cost in USD cents (integer) or fractional currency units. Optional.
// The optional axes are only *enforced* by a budget that declares them: an
// undeclared memory/latency/money budget means "unlimited on that axis", not zero — so
// existing { tokens, durationMs } code stays unconstrained on the new axes.
export type Cost = {
  tokens: number;
  durationMs: number;
  memory?: number;
  latency?: number;
  /** Financial cost in USD cents (integer) or fractional currency units. Optional. Used for tool call cost tracking. */
  money?: number;
};

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "paused"
  | "pendingCommit";

// Risk tracks both the static prior declared by the developer and the
// continuously-updated estimate derived from observed evidence.
// currentRisk can always exceed staticRisk — a low prior is never a ceiling.
export type RiskState = {
  staticRisk: number;
  currentRisk: number;
  predictedRisk: number;
  confidence: number;
  escalated: boolean;
};

// Trust is purely evidence-derived. Score is normalized 0-1.
// Asymmetric decay: failures penalise more than successes reward (spec §Asymmetric Reputation Decay).
export type TrustState = {
  score: number;
  successfulExecutions: number;
  failedExecutions: number;
  surpriseEvents: number;
};

// Task is the unit of governance. Owns budget, risk, trust, audit, checkpoints.
// Every execution event is attributable to a TaskID (invariant 1).
export type Task = {
  id: string;
  rootId: string;
  parentId?: string;
  status: ExecutionStatus;
  goal: string;
  assignedAgent: string;
  workflow?: string;
  currentPhase?: string;
  budget: Cost;
  risk: RiskState;
  trust: TrustState;
  createdAt: Date;
  updatedAt: Date;
};

// Bounded supervision tree (spec §Supervision Tree).
// maxConcurrency is a literal 2 — enforced by the engine, not configurable.
export type TaskTree = {
  rootTaskId: string;
  activeChildren: string[];
  queuedChildren: string[];
  maxConcurrency: 2;
};

// A single action run: records the action, timing, status, and cost.
export type Execution = {
  id: string;
  taskId: string;
  action: string;
  startedAt: Date;
  endedAt?: Date;
  status: ExecutionStatus;
  cost: Cost;
};

// A recoverable state boundary. Recovery resumes from the latest valid checkpoint.
// state captures the task state snapshot at checkpoint time.
export type Checkpoint = {
  id: string;
  taskId: string;
  phase?: string;
  state: JsonRecord;
  createdAt: Date;
};

// A human approval request. Execution for requiresApproval actions halts until resolved.
export type ApprovalRequest = {
  id: string;
  taskId: string;
  action: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
};

// Escalation triggers (spec §Human Oversight). Every escalation is TaskID-attributable (invariant 13).
export type EscalationTrigger =
  | "risk-threshold"
  | "bayesian-surprise"
  | "trust-degradation"
  | "policy-violation"
  | "budget-violation"
  | "workflow-failure"
  | "reasoner-failure"
  | "explicit";

// Every escalation is stored and attributable so oversight is never silent (invariant 13).
export type EscalationRecord = {
  id: string;
  taskId: string;
  trigger: EscalationTrigger;
  reason: string;
  createdAt: Date;
};

// All messages are TaskID-attributable (invariant 9).
// payload is JSON-serialized to stay storable without schema drift.
export type Message = {
  id: string;
  taskId: string;
  sender: string;
  receiver: string;
  payload: Json;
  createdAt: Date;
  /**
   * Whether this message has been delivered to its receiver. Set when an agent
   * folds a mention addressed to it into its reasoning context, so a mention is
   * delivered exactly once across all of the recipient's tasks. Absent/false
   * means undelivered. (Caller-queue messages use the per-task drain instead.)
   */
  consumed?: boolean;
};

// A retrieved-on-demand piece of context (spec principle 4: memory is retrieved,
// not carried). Owned by an agent and attributable to the TaskID in whose context
// it was created (invariant 8). Retrieval scopes by agentName so knowledge persists
// across that agent's tasks.
export type Memory = {
  id: string;
  taskId: string;
  agentName: string;
  /** Free-form label, e.g. "note" | "fact" | "observation". */
  kind: string;
  content: string;
  createdAt: Date;
};

// An agent-driven checkpoint with optional notes, saved when a workflow
// completes (or optionally during a free-loop task). The engine already
// checkpoints automatically — a Commit is the agent's acknowledgment +
// annotation of that completion. Mandatory for workflows, optional for
// free-loop tasks.
export type Commit = {
  id: string;
  taskId: string;
  agentName: string;
  /** null for free-loop commits, workflow name for workflow commits. */
  workflowName: string | null;
  /** Optional agent-supplied notes about what was accomplished. */
  notes: string | null;
  /** Link to the engine's checkpoint that was active at commit time. */
  checkpointId: string | null;
  createdAt: Date;
};

// Query parameters for searching commits. Used by the system:search_commits
// internal tool so agents can pull older commits on demand.
export type CommitQuery = {
  /** Keyword search over notes (case-insensitive substring match). */
  query?: string;
  /** Filter by workflow name. */
  workflowName?: string;
  /** When true, search across all agents. Default: current agent only. */
  allAgents?: boolean;
  /** Max results. Default 20. */
  limit?: number;
};

// FIFO queue tracks work items by ID for deterministic ordering and replay.
export type Queue = {
  id: string;
  taskId: string;
  pending: string[];
  active: string[];
  completed: string[];
};

// Supervision strategy applied consistently for the lifetime of a task.
export type SupervisionPolicy = {
  strategy:
    | "retry"
    | "restart"
    | "resume"
    | "escalate"
    | "abort-subtree"
    | "abort-tree";
  maxRetries: number;
};
