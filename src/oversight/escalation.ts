/**
 * Escalation detection and recording.
 *
 * Two distinct responsibilities:
 *
 * 1. checkEscalation (pure) — evaluates all signals and returns whether and
 *    why escalation is needed. No I/O. Deterministic on its inputs. The engine
 *    calls this before committing to any decision that might need oversight.
 *
 * 2. raiseEscalation (effectful) — writes an EscalationRecord to the store,
 *    making the escalation auditable and TaskID-attributable. Never silent.
 *
 * Priority order when multiple signals fire simultaneously:
 *   risk-threshold > bayesian-surprise > budget-violation >
 *   policy-violation > workflow-failure > explicit
 *
 * This ordering is intentional: governance-derived signals (risk, surprise, budget)
 * outrank configuration-level signals (policy, workflow, explicit) because
 * the engine's continuous estimates carry more information than static flags.
 *
 * Covers: invariant 13 (every escalation is auditable).
 */

import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import type { EscalationRecord, EscalationTrigger } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { EscalationContext, EscalationCheck } from "./types";
import { shouldEscalate as isRiskAboveThreshold } from "../governance/risk";
import { escalationId } from "../shared/id";

// Surprise threshold: normalised surprise >= 0.7 warrants human attention.
// Conservative by design (spec §Follow-Up Work: Governance Metric Calibration).
const SURPRISE_THRESHOLD = 0.7;

/**
 * Pure escalation check. Evaluates all available signals and returns the first
 * trigger that fires, or `{ escalate: false }` when the task may continue.
 *
 * Callers should pass the result to raiseEscalation when escalate is true.
 */
export const checkEscalation = (ctx: EscalationContext): EscalationCheck => {
  // Risk threshold — delegates to governance/risk for consistent threshold logic.
  if (isRiskAboveThreshold(ctx.risk)) {
    return {
      escalate: true,
      trigger: "risk-threshold",
      reason:
        `current risk (${ctx.risk.currentRisk.toFixed(2)}) or predicted risk ` +
        `(${ctx.risk.predictedRisk.toFixed(2)}) exceeds the escalation threshold`,
    };
  }

  // Bayesian surprise — unexpected divergence from the predicted trajectory.
  if (ctx.surpriseMagnitude !== undefined && ctx.surpriseMagnitude >= SURPRISE_THRESHOLD) {
    return {
      escalate: true,
      trigger: "bayesian-surprise",
      reason:
        `surprise magnitude (${ctx.surpriseMagnitude.toFixed(2)}) exceeds ` +
        `threshold (${SURPRISE_THRESHOLD}) — observed behaviour diverged from prediction`,
    };
  }

  // Budget violation — either resource axis exceeded means the task is out of scope.
  if (ctx.spent.tokens > ctx.budget.tokens || ctx.spent.durationMs > ctx.budget.durationMs) {
    return {
      escalate: true,
      trigger: "budget-violation",
      reason: "task has exceeded its allocated budget; human decision required before continuing",
    };
  }

  // Policy violation — a configured governance rule was broken.
  if (ctx.hasPolicyViolation === true) {
    return {
      escalate: true,
      trigger: "policy-violation",
      reason: "a configured governance policy was violated during this execution step",
    };
  }

  // Workflow failure — the workflow reached a terminal failure state.
  if (ctx.hasWorkflowFailure === true) {
    return {
      escalate: true,
      trigger: "workflow-failure",
      reason: "a workflow reached a terminal failure state and requires human review",
    };
  }

  // Explicit — the agent or workflow explicitly requested oversight.
  if (ctx.explicitEscalation === true) {
    return {
      escalate: true,
      trigger: "explicit",
      reason: "human oversight explicitly requested by agent or workflow configuration",
    };
  }

  return { escalate: false };
};

/**
 * Persist an escalation event. Returns the saved record so callers can
 * reference the escalation id for subsequent audits or resolution workflows.
 *
 * Every escalation must be saved — no silent escalation paths are permitted
 * (invariant 13: every escalation is auditable).
 */
export const raiseEscalation = async ({
  taskId,
  trigger,
  reason,
  store,
}: {
  taskId: string;
  trigger: EscalationTrigger;
  reason: string;
  store: StoragePort;
}): Promise<Result<EscalationRecord, string>> => {
  const record: EscalationRecord = {
    id: escalationId(),
    taskId,
    trigger,
    reason,
    createdAt: new Date(),
  };
  const saved = await store.saveEscalation(record);
  if (saved.isErr) {
    return Err(`failed to record escalation for task "${taskId}": ${saved.error}`);
  }
  return Ok(record);
};

/**
 * Retrieve all escalation records for a task in insertion order.
 * The engine and callers use this to inspect the oversight history for a task.
 */
export const getEscalations = async ({
  taskId,
  store,
}: {
  taskId: string;
  store: StoragePort;
}): Promise<Result<EscalationRecord[], string>> => {
  return store.getEscalationsByTask(taskId);
};
