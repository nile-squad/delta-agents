/**
 * Execution gateway — the single chokepoint for all action execution.
 *
 * Every action the engine runs passes through this function. No bypasses exist.
 * The pipeline is deterministic and ordered:
 *
 *   1. Schema validation   — blocks before any governance machinery runs
 *   2. Legality check      — re-evaluates the Markov state at execution time
 *   3. Approval gate       — enforces requiresApproval declarations
 *   4. Before hook         — setup only; cannot authorize or bypass governance
 *   5. fn() execution      — the action logic; throws are caught and treated as failure
 *   6. After / onError     — teardown; cannot alter the fn result
 *   7. Trust + risk update — evidence updates the running estimates
 *   8. Execution record    — written to store; TaskID-attributable (invariant 1)
 *
 * Returns Ok(GatewaySuccess) when fn ran (fnResult carries Ok or Err from fn).
 * Returns Err(string)        when the gateway blocked before fn could run.
 *
 * Covers: invariants 1, 3, 4, 18, 19, 22; prohibitions 1, 2, 9, 17, 18.
 */

import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import type { GatewayInput, GatewaySuccess } from "./types";
import type { ActionContext } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import { checkLegality } from "../state-space/check-legality";
import { withCompletedAction, withSpent } from "../state-space/task-state";
import { updateTrust } from "../governance/trust";
import { updateRisk } from "../governance/risk";
import { assembleStepSignals } from "../governance/step-signals";
import { executionId } from "../shared/id";
import { zeroCost } from "../shared/cost";
import { runHook } from "./run-hooks";

export const runGateway = async ({
  action,
  rawInput,
  state,
  approvalStatus,
  store,
  reasoningCost,
  stepIndex = 0,
  communicate,
}: GatewayInput): Promise<Result<GatewaySuccess, string>> => {
  // ── 1. Schema validation ────────────────────────────────────────────────
  // Must be the first check. An invalid schema means the reasoner sent bad
  // input; governance machinery must not run on malformed data (prohibition 9).
  const parsed = action.schema.safeParse(rawInput);
  if (!parsed.success) {
    return Err(`schema-invalid: ${parsed.error.message}`);
  }
  const validatedInput = parsed.data as Record<string, unknown>;

  // ── 2. Legality check ──────────────────────────────────────────────────
  // Re-run at execution time: state can have changed since the reasoner
  // received the discovery list (escalation, budget exhaustion, etc.).
  const legality = checkLegality({ action, state });
  if (!legality.legal) {
    return Err(`not-legal: ${legality.reason}`);
  }

  // ── 3. Approval gate ───────────────────────────────────────────────────
  // requiresApproval is a hard constraint — the engine cannot proceed without
  // a resolved human decision (prohibitions 1, 2).
  if (action.requiresApproval === true && approvalStatus !== "approved") {
    const detail =
      approvalStatus === "pending"
        ? "approval is pending human resolution"
        : approvalStatus === "rejected"
          ? "approval was rejected by a human reviewer"
          : "approval has not been requested yet";
    return Err(
      `approval-required: action "${action.name}" requires human approval — ${detail}`,
    );
  }

  // ── 4. Assemble execution context ─────────────────────────────────────
  const excId = executionId();
  const ctx: ActionContext = {
    taskId: state.taskId,
    executionId: excId,
    agentName: state.agentName,
    phase: state.currentPhase,
    ...(communicate !== undefined ? { communicate } : {}),
  };

  // ── 5. Before hook ─────────────────────────────────────────────────────
  // Hooks observe and prepare; they never authorize or bypass governance.
  // A before-hook failure means setup couldn't complete — block execution
  // without treating the hook as a governance decision-maker.
  const beforeResult = await runHook(action.hooks?.before, ctx);
  if (beforeResult.isErr) {
    return Err(`before-hook-failed: ${beforeResult.error}`);
  }

  // ── 6. Write initial Execution record ─────────────────────────────────
  // Written before fn runs so provenance is established regardless of outcome
  // (invariant 1: every execution event is TaskID-attributable).
  const startedAt = new Date();
  const initialExecution = {
    id: excId,
    taskId: state.taskId,
    action: action.name,
    startedAt,
    status: "running" as const,
    cost: zeroCost(),
  };
  await store.saveExecution(initialExecution);

  // ── 7. Run fn() ────────────────────────────────────────────────────────
  // Manual try-catch preserves the Result passthrough: fn's Ok/Err arrives
  // intact. safeTry is not used here because it evaluates Result return values
  // and would unwrap them, losing fnResult.isOk and breaking trust accounting.
  // A thrown error is a contract violation — treated as fn returning Err
  // (prohibition 18: never infer success from the absence of a throw).
  let fnResult: Result<unknown, string>;
  try {
    fnResult = await action.fn(validatedInput, ctx);
  } catch (e) {
    fnResult = Err(`fn threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  // Cost = reasoning tokens (from the model adapter's usage) + fn wall-clock time.
  // Tokens are the primary governance currency; threading them here makes token
  // budget enforcement real (spec §Bellman Optimization).
  const actualCost = { tokens: reasoningCost?.tokens ?? 0, durationMs };

  const fnSucceeded = fnResult.isOk;

  // ── 8. After / onError hook ────────────────────────────────────────────
  // Run teardown hooks. Their results do not alter fnResult or the
  // governance decision already made above (prohibition 17).
  if (fnSucceeded) {
    await runHook(action.hooks?.after, ctx);
  } else {
    await runHook(action.hooks?.onError, ctx);
  }

  // ── 9. Finalise Execution record ────────────────────────────────────────
  const finalStatus = fnSucceeded ? ("completed" as const) : ("failed" as const);
  await store.updateExecution(excId, {
    endedAt,
    status: finalStatus,
    cost: actualCost,
  });
  const execution = {
    ...initialExecution,
    endedAt,
    status: finalStatus,
    cost: actualCost,
  };

  // ── 10. Assemble real governance signals ───────────────────────────────
  // Friction, Bayesian surprise, and the Kalman health estimate are computed
  // from this step's observed cost and progress (was hardcoded to zero, so risk
  // only ever moved on failure rate and surprise escalation was unreachable).
  const completedAfter =
    fnSucceeded && !state.completedActions.includes(action.name)
      ? state.completedActions.length + 1
      : state.completedActions.length;
  const signals = assembleStepSignals({
    priorKalman: state.kalman,
    anticipatedRisk: action.risk,
    hasEstimatedCost: action.estimatedCost !== undefined,
    priorSpent: state.spent,
    actualCost,
    budget: state.budget,
    completedActionsCount: completedAfter,
    stepIndex,
    fnSucceeded,
  });

  // ── 11. Update trust (asymmetric decay) ────────────────────────────────
  // Success accrues slowly; failure decays fast (spec §Asymmetric Reputation Decay).
  const updatedTrust = updateTrust({
    current: state.trust,
    outcome: fnSucceeded ? "success" : "failure",
  });

  // ── 12. Update risk from evidence ─────────────────────────────────────
  const updatedRisk = updateRisk({ current: state.risk, evidence: signals.evidence });

  // ── 13. Produce updated snapshot ───────────────────────────────────────
  // Only Ok outcomes add the action to completedActions — never infer
  // success from the absence of an error (invariant 19). Kalman health carries
  // forward so the estimator warms up across steps and survives pause/resume.
  let updatedSnapshot: TaskStateSnapshot = { ...state, trust: updatedTrust, risk: updatedRisk, kalman: signals.kalman };

  if (fnSucceeded) {
    updatedSnapshot = withCompletedAction({
      snapshot: updatedSnapshot,
      actionName: action.name,
      cost: actualCost,
    });
  } else {
    updatedSnapshot = withSpent({ snapshot: updatedSnapshot, spent: actualCost });
  }

  return Ok({ fnResult, execution, updatedSnapshot, surpriseMagnitude: signals.surprise.magnitude });
};
