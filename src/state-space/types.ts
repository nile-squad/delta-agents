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

import type { Cost, ExecutionStatus, RiskState, TrustState } from "../shared/types";

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

  currentWorkflow?: string;
  currentPhase?: string;

  // When this is a subtask, parentBudget constrains what can be spent.
  // A subtask never gains authority beyond its parent scope (invariant 18).
  parentBudget?: Cost;
  parentSpent?: Cost;
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
