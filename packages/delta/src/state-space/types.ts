/**
 * State-space types.
 *
 * TaskStateSnapshot is the Markov state: a complete, self-contained view of
 * task governance at a single point in time. Every legality check, prerequisite
 * evaluation, and action discovery call takes a snapshot — never a history log.
 * The engine can always re-derive the next legal actions from the snapshot alone.
 *
 * This is what makes the governance model stateless and reproducible
 * (spec §Markov Constraints, Decision: Stateless Governance Engine).
 */

import type { Attachment, Cost, ExecutionStatus, RiskState, TrustState } from "../shared/types";
import type { KalmanState } from "../governance/types";
import type { ToolHistoryEntry } from "../authoring/types";

export type TaskStateSnapshot = {
  taskId: string;
  rootId: string;
  agentName: string;
  status: ExecutionStatus;

  // Completed actions and workflows drive prerequisite evaluation.
  // Only actions that returned Ok count as completed (engine never infers
  // success from the absence of a throw — spec invariant 19).
  completedActions: string[];
  completedWorkflows: string[];

  budget: Cost;
  spent: Cost;

  risk: RiskState;
  trust: TrustState;

  // Continuous execution-health estimate, carried across steps so the Kalman
  // filter warms up instead of cold-starting every action. Undefined on the
  // first step; the gateway seeds it from the action's risk/cost priors.
  // Persisted in the checkpoint snapshot, so it survives pause/resume.
  kalman?: KalmanState;

  currentWorkflow?: string;
  currentPhase?: string;

  // When this is a subtask, parentBudget constrains what can be spent.
  // A subtask never gains authority beyond its parent scope (invariant 18).
  parentBudget?: Cost;
  parentSpent?: Cost;

  // Ids of caller Messages already folded into the goal by the queue drain
  // (H5b). Carried on the snapshot so draining stays idempotent across
  // pause/resume — a message is consumed exactly once (spec §Queueing Model,
  // invariant 9). Persisted inside the checkpoint JsonRecord, not a DB column.
  consumedMessages?: string[];

  // ── Workflow resume state ────────────────────────────────────────────────
  // Names of phases in the current workflow that have already completed. A
  // resume skips these instead of re-running them, so a checkpointed workflow
  // does not re-execute side-effectful phases on recovery (mid-workflow resume).
  // Every completed phase writes a checkpoint recording itself here, so the
  // skip set is exactly what the store can prove finished.
  completedPhases?: string[];

  // When a phase escalated part way through (some actions done, one failed), this
  // is the action index at which to re-enter `currentPhase` on resume, so the
  // already-completed actions in that phase are not re-executed (mid-phase
  // resume). Set only on the checkpoint written at a mid-phase escalation.
  currentActionIndex?: number;

  // True when `currentActionIndex` points at a branch jump target: the resumed
  // phase must terminate after that action completes (decision-tree semantics,
  // invariant 21) instead of continuing sequentially. Persisted alongside
  // currentActionIndex on the mid-phase escalation checkpoint.
  currentActionViaJump?: boolean;

  // The send-time inputs for a workflow task, carried on the snapshot so a
  // resumed workflow re-runs faithfully. The deterministic (reasoner-less)
  // workflow path has no other source for them after a process restart, so they
  // are persisted in the checkpoint rather than held only in the send call.
  // Values must be JSON-serializable (they round-trip through the checkpoint).
  workflowInput?: Record<string, unknown>;
  workflowActionInputs?: Record<string, Record<string, string | number | boolean | null>>;

  /** Tool execution history for audit and checkpointing. Every tool call is recorded with full context. */
  toolHistory?: ToolHistoryEntry[];

  /**
   * Attachments supplied at send() time, engine-issued ids attached. Persists
   * across the whole task run (checkpointed like toolHistory) and is forwarded
   * to ReasonerInput on every reasoner call unchanged — the same "always resend
   * relevant state" pattern the rest of the snapshot already follows, since each
   * reasoner call is a fresh reconstruction with no native provider-side
   * conversation memory. Also surfaced to tools via ToolContext.attachments so a
   * future extraction tool can look up raw bytes by id.
   */
  attachments?: Attachment[];

  /**
   * Result of the model's most recent `tool-info` request (schema, history, or
   * history-entry). Carried on the snapshot so the model sees it as part of the
   * user message on the next `reason()` call. Cleared by a subsequent tool-info
   * request that overwrites it, or naturally expires once the model acts on it.
   */
  lastToolInfoResult?: string;

  /**
   * The most recent invalid model decision (unknown action / schema-invalid
   * input), fed back to the model on the next `reason()` call so it can
   * self-correct instead of failing the task. `consecutiveCount` bounds the
   * feedback loop (engine `maxInvalidDecisionRetries`); any valid decision
   * clears this field, resetting the counter.
   */
  lastDecisionError?: { reason: string; consecutiveCount: number };
};

// Result of a legality check. Includes a reason when illegal so the caller
// (gateway, oversight) can log and attribute the denial.
export type LegalityResult =
  | { legal: true }
  | { legal: false; reason: string };

// Result of prerequisite evaluation — separate from legality so the engine
// can distinguish "action does not exist" from "action exists but gated".
export type PrerequisiteResult =
  | { satisfied: true }
  | { satisfied: false; reason: string };
