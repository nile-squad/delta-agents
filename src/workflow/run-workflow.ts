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

import type { WorkflowResult, RunWorkflowInput } from "./types";
import { runPhase } from "./run-phase";
import { runHook } from "../execution/run-hooks";
import { withCompletedWorkflow } from "../state-space/task-state";
import { executionId } from "../shared/id";
import type { ActionContext } from "../authoring/types";

export const runWorkflow = async ({
  workflow,
  actionRegistry,
  state,
  getApprovalStatus,
  inputFor,
  store,
}: RunWorkflowInput): Promise<WorkflowResult> => {
  const workflowCtx: ActionContext = {
    taskId: state.taskId,
    executionId: executionId(),
    agentName: state.agentName,
    phase: undefined,
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
    const phaseResult = await runPhase({
      phase,
      actionRegistry,
      state: currentState,
      getApprovalStatus,
      inputFor,
      store,
    });

    currentState = phaseResult.snapshot;

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
