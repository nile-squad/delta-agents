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

// Resource consumption for a task or action execution.
// Tokens represent model token usage; durationMs is wall-clock time.
export type Cost = {
  tokens: number;
  durationMs: number;
};

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "paused";

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
