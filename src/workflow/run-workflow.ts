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
import { withCompletedWorkflow, snapshotFromJson, snapshotToJson } from "../state-space/task-state";
import { applyStrategy, abortTask, abortEntireTree } from "../supervision";
import { raiseEscalation } from "../oversight";
import { retryWithJitter } from "../infra";
import { executionId, checkpointId } from "../shared/id";
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
  const first = await runPhase(input);
  if (first.status !== "failed") return first;
  if (input.phase.supervision === undefined) return first;

  const policy = input.phase.supervision;
  const taskId = input.state.taskId;

  // Fetch the latest checkpoint once so the `resume` decision has a checkpointId.
  // applyStrategy maps resume-with-no-checkpoint → restart automatically, so the
  // downstream switch only needs to handle what the decision actually says.
  const latestCkpt = await input.store.getLatestCheckpoint(taskId);
  const latestCheckpointId =
    latestCkpt.isOk && latestCkpt.value !== null ? latestCkpt.value.id : undefined;
  const decision = applyStrategy({ policy, retryCount: 0, checkpointId: latestCheckpointId });

  switch (decision.action) {
    case "escalate": {
      await raiseEscalation({ taskId, trigger: "workflow-failure", reason: first.failedReason, store: input.store });
      // Persist mid-phase progress so resume re-enters this phase at the action
      // that failed, not from the top: the actions completed before the failure
      // are not re-executed (mid-phase resume). The completed-phases set on the
      // snapshot still skips the phases that finished before this one.
      await input.store.saveCheckpoint({
        id: checkpointId(),
        taskId,
        phase: input.phase.name,
        state: snapshotToJson({
          ...first.snapshot,
          status: "paused",
          currentPhase: input.phase.name,
          currentActionIndex: first.failedIndex ?? 0,
        }),
        createdAt: new Date(),
      });
      await input.store.updateTask(taskId, { status: "paused", updatedAt: new Date() });
      return {
        status: "blocked",
        snapshot: first.snapshot,
        reason: `escalated: phase "${input.phase.name}" failed — ${first.failedReason}`,
      };
    }

    case "abort-subtree": {
      // abort-subtree aborts only this task. Task trees are stored flat (one tree
      // per root with its children), so a non-root task owns no nested subtree of
      // its own: its subtree is itself. Aborting just this task leaves siblings
      // and the root running, which is the intended scoped abort.
      await abortTask({ taskId, store: input.store });
      return {
        status: "failed",
        snapshot: first.snapshot,
        failedReason: `aborted (abort-subtree): phase "${input.phase.name}" failed: ${first.failedReason}`,
      };
    }

    case "abort-tree": {
      // abort-tree aborts the ENTIRE tree, not just this task: the root and every
      // active/queued child are marked aborted and the tree is cleared so no queued
      // child is later promoted (invariant 17, prohibition 11). The tree is keyed by
      // rootId, so cascade from the snapshot's rootId regardless of whether the
      // failing task is the root or a delegated child.
      const cascade = await abortEntireTree({ rootTaskId: input.state.rootId, store: input.store });
      if (cascade.isErr) {
        return {
          status: "failed",
          snapshot: first.snapshot,
          failedReason: `aborted (abort-tree) but cascade failed on phase "${input.phase.name}": ${cascade.error}`,
        };
      }
      return {
        status: "failed",
        snapshot: first.snapshot,
        failedReason: `aborted (abort-tree): phase "${input.phase.name}" failed: ${first.failedReason}`,
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
      // Build the per-strategy re-run input:
      //   retry  → resume from the failed action index, preserving prior phase progress
      //            (keeps first.snapshot so completedActions from earlier steps survive).
      //   restart→ re-run from phase entry state (input.state), index 0.
      //   resume → re-run from the latest checkpoint state, index 0
      //            (applyStrategy already downgraded resume→restart when no checkpoint exists,
      //            so the latestCkpt guard here is a belt-and-suspenders check only).
      const reRunInput = (): RunPhaseInput => {
        if (decision.action === "retry") {
          return { ...input, state: first.snapshot, startIndex: first.failedIndex ?? 0 };
        }
        if (decision.action === "resume" && latestCkpt.isOk && latestCkpt.value !== null) {
          return {
            ...input,
            state: { ...snapshotFromJson(latestCkpt.value.state), status: "running" },
            startIndex: 0,
          };
        }
        // restart (or resume-fell-back-to-restart): re-run from phase entry state, index 0.
        return { ...input, state: input.state, startIndex: 0 };
      };

      // Re-run with jittered backoff (AGENTS.md: never raw sleep+backoff).
      // Stop early on completion or escalation; only a plain failure consumes a retry.
      const retried = await retryWithJitter<PhaseResult>({
        fn: async () => {
          const r = await runPhase(reRunInput());
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
  remember,
  agentSkills,
}: RunWorkflowInput): Promise<WorkflowResult> => {
  const workflowCtx: ActionContext = {
    taskId: state.taskId,
    executionId: executionId(),
    agentName: state.agentName,
    phase: undefined,
    ...(communicate !== undefined ? { communicate } : {}),
    ...(remember !== undefined ? { remember } : {}),
    ...(workflow.storyline !== undefined ? { storyline: workflow.storyline } : {}),
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

  // Phases proven complete by a prior run (from the resume snapshot's checkpoint)
  // are skipped so a recovered workflow does not re-execute finished, possibly
  // side-effectful phases. On a fresh send this set is empty (mid-workflow resume).
  const alreadyDone = new Set(state.completedPhases ?? []);

  // On resume from a mid-phase escalation, the in-progress phase re-enters at the
  // action it reached rather than at the top, so its already-completed actions do
  // not re-run (mid-phase resume). Captured from the resume snapshot; absent on a
  // fresh send.
  const resumePhase = state.currentPhase;
  const resumeActionIndex = state.currentActionIndex;

  for (const phase of workflow.phases) {
    if (alreadyDone.has(phase.name)) continue;

    const startIndex =
      phase.name === resumePhase && resumeActionIndex !== undefined ? resumeActionIndex : undefined;

    const phaseResult = await runPhaseSupervised({
      phase,
      actionRegistry,
      state: currentState,
      getApprovalStatus,
      inputFor,
      store,
      communicate,
      remember,
      agentSkills,
      ...(startIndex !== undefined ? { startIndex } : {}),
      ...(workflow.storyline !== undefined ? { storyline: workflow.storyline } : {}),
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
