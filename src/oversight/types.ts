/**
 * Oversight-specific types for approval and escalation flow.
 *
 * EscalationTrigger and EscalationRecord live in shared/types because they are
 * runtime records owned by the engine (like Execution and Checkpoint). The
 * types here capture the *inputs* to the escalation decision — the context the
 * oversight module evaluates — and the output of the pure check function.
 *
 * Escalation is not optional. Every path that could endanger task integrity
 * must flow through checkEscalation before proceeding (spec §Human Oversight).
 */

import type { Cost, RiskState } from "../shared/types";
import type { EscalationTrigger } from "../shared/types";

/**
 * All signals the engine collects before deciding whether to escalate.
 * Every field except risk, spent, and budget is optional — the engine may
 * not have computed every signal at every decision point.
 */
export type EscalationContext = {
  /** Current risk state — drives the risk-threshold trigger. */
  risk: RiskState;
  /** Resources consumed so far — compared against budget for budget-violation. */
  spent: Cost;
  /** Task budget ceiling — any axis exceeded triggers budget-violation. */
  budget: Cost;
  /**
   * Normalised [0, 1] Bayesian surprise magnitude from the governance estimator.
   * At or above 0.7 triggers bayesian-surprise escalation.
   */
  surpriseMagnitude?: number;
  /** True when a configured policy was violated in the current execution step. */
  hasPolicyViolation?: boolean;
  /** True when a workflow reached a failed terminal state. */
  hasWorkflowFailure?: boolean;
  /** True when the agent or workflow explicitly requests human oversight. */
  explicitEscalation?: boolean;
};

/** Result of the pure escalation check — either no action needed or a typed trigger. */
export type EscalationCheck =
  | { escalate: false }
  | { escalate: true; trigger: EscalationTrigger; reason: string };
