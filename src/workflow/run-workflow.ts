/**
 * Workflow runner — orchestrates phases sequentially.
 *
 * Phases run in declared order. The TaskStateSnapshot is threaded through
 * each phase so completedActions, spent cost, trust, and risk accumulate
 * correctly across phase boundaries.
 *
 * A phase failure halts the workflow immediately. The snapshot at the point
 * of failure is returned so the supervision layer (Phase 6) can decide
 * whether to retry, restart, resume from checkpoint, or escalate.
 *
 * After all phases succeed, the workflow name is added to the snapshot's
 * completedWorkflows (used for prerequisite gating on dependent actions).
 *
 * Workflow lifecycle hooks run around the full workflow.
 */

import { Ok, Err } from "slang-ts";
import type { WorkflowResult, RunWorkflowInput, PhaseResult, RunPhaseInput } from "./types";
import { runPhase } from "./run-phase";
import { runHook } from "../execution/run-hooks";
import { withCompletedWorkflow } from "../state-space/task-state";
import { applyStrategy, abortTask } from "../supervision";
import { raiseEscalation } from "../oversight";
import { retryWithJitter } from "../infra";
import { executionId } from "../shared/id";
import type { ActionContext } from "../authoring/types";

/**
 * Run a phase, then apply its declared supervision policy if it fails (H1).
 *
 * A "completed" or "blocked" (escalated) phase is returned as-is. A "failed"
 * phase with no supervision policy propagates the failure unchanged (current
 * default). With a policy, the strategy is applied deterministically
 * (prohibition 10): retry/restart/resume re-run the phase up to maxRetries with
 * jittered backoff; escalate pauses the task and blocks; abort-* aborts the task;
 * give-up surfaces a clear unrecoverable failure.
 *
 * Supervision is applied at phase granularity (re-run the whole phase), not per
 * action — the phase is the recovery boundary the spec defines (§Checkpointing,
 * §Supervision Model). Action-level retry is a future refinement.
 */
const runPhaseSupervised = async (input: RunPhaseInput): Promise<PhaseResult> => {
  const runOnce = (): Promise<PhaseResult> => runPhase(input);

  const first = await runOnce();
  if (first.status !== "failed") return first;
  if (input.phase.supervision === undefined) return first;

  const policy = input.phase.supervision;
  const taskId = input.state.taskId;
  const decision = applyStrategy({ policy, retryCount: 0 });

  switch (decision.action) {
    case "escalate": {
      await raiseEscalation({ taskId, trigger: "workflow-failure", reason: first.failedReason, store: input.store });
      await input.store.updateTask(taskId, { status: "paused", updatedAt: new Date() });
      return {
        status: "blocked",
        snapshot: first.snapshot,
        reason: `escalated: phase "${input.phase.name}" failed — ${first.failedReason}`,
      };
    }

    case "abort-subtree":
    case "abort-tree": {
      await abortTask({ taskId, store: input.store });
      return {
        status: "failed",
        snapshot: first.snapshot,
        failedReason: `aborted (${decision.action}): phase "${input.phase.name}" failed — ${first.failedReason}`,
      };
    }

    case "give-up":
      return {
        status: "failed",
        snapshot: first.snapshot,
        failedReason: `supervision gave up on phase "${input.phase.name}": ${decision.reason}`,
      };

    case "retry":
    case "restart":
    case "resume": {
      // Re-run from the phase entry state, up to maxRetries, with jittered backoff
      // (AGENTS.md: never raw sleep + manual backoff). Stop early on completion or
      // escalation; only a plain failure consumes a retry.
      const retried = await retryWithJitter<PhaseResult>({
        fn: async () => {
          const r = await runOnce();
          return r.status === "failed" ? Err(r.failedReason) : Ok(r);
        },
        options: { maxAttempts: policy.maxRetries, baseDelayMs: 5, maxDelayMs: 50, jitterFactor: 0.5 },
      });
      if (retried.isOk) return retried.value;
      return {
        status: "failed",
        snapshot: input.state,
        failedReason: `supervision "${decision.action}" exhausted ${policy.maxRetries} attempt(s) on phase "${input.phase.name}": ${retried.error}`,
      };
    }
  }
};

export const runWorkflow = async ({
  workflow,
  actionRegistry,
  state,
  getApprovalStatus,
  inputFor,
  store,
  communicate,
}: RunWorkflowInput): Promise<WorkflowResult> => {
  const workflowCtx: ActionContext = {
    taskId: state.taskId,
    executionId: executionId(),
    agentName: state.agentName,
    phase: undefined,
    ...(communicate !== undefined ? { communicate } : {}),
  };

  // Workflow before hook.
  const beforeResult = await runHook(workflow.hooks?.before, workflowCtx);
  if (beforeResult.isErr) {
    return {
      status: "failed",
      snapshot: state,
      failedReason: `workflow before-hook failed: ${beforeResult.error}`,
    };
  }

  let currentState: typeof state = { ...state, currentWorkflow: workflow.name };

  for (const phase of workflow.phases) {
    const phaseResult = await runPhaseSupervised({
      phase,
      actionRegistry,
      state: currentState,
      getApprovalStatus,
      inputFor,
      store,
      communicate,
    });

    currentState = phaseResult.snapshot;

    if (phaseResult.status === "blocked") {
      await runHook(workflow.hooks?.onError, workflowCtx);
      return {
        status: "blocked",
        snapshot: currentState,
        failedPhase: phase.name,
        reason: phaseResult.reason,
      };
    }

    if (phaseResult.status === "failed") {
      await runHook(workflow.hooks?.onError, workflowCtx);
      return {
        status: "failed",
        snapshot: currentState,
        failedPhase: phase.name,
        failedReason: phaseResult.failedReason,
      };
    }
  }

  // All phases completed. Record the workflow completion in the snapshot so
  // downstream actions with workflow prerequisites can be unblocked.
  const finalSnapshot = withCompletedWorkflow({
    snapshot: currentState,
    workflowName: workflow.name,
  });

  await runHook(workflow.hooks?.after, workflowCtx);
  return { status: "completed", snapshot: finalSnapshot };
};
