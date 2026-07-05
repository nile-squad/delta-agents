/**
 * Phase runner — executes a phase's action list through the gateway.
 *
 * Processes ActionRefs sequentially. String refs run in order; Branch refs
 * apply an optional guard then route based on the action's outcome.
 *
 * Guards (Branch.when) are evaluated before the action runs. A false guard
 * skips the branch entirely and advances to the next ref in the list.
 *
 * After every action, resolveNextStep determines the next position with no
 * invented transitions (invariant 21, prohibition 19).
 *
 * A step limit of 100 per phase prevents developer-defined cycles from
 * running forever. The spec does not prohibit cycles but they are always a
 * design error, so a loud failure with a clear reason is appropriate.
 *
 * Phase lifecycle hooks (before/after/onError) run around the full phase,
 * not around individual actions. Action-level hooks live inside runGateway.
 *
 * A checkpoint is ALWAYS written after a successful phase (invariant 10: every
 * checkpoint is recoverable). Without it, a workflow that blocks in a later
 * phase would resume from a stale checkpoint and re-execute this phase's side
 * effects. A mid-phase escalation likewise writes a positional checkpoint
 * (currentActionIndex) so resume re-enters the phase after the action that
 * already succeeded, never re-running it.
 */

import { option } from "slang-ts";
import type { ActionContext } from "../authoring/types";
import type { Checkpoint } from "../shared/types";
import type { PhaseResult, RunPhaseInput } from "./types";
import { buildAvailableSkills, resolveSkillRefs } from "../skills";
import type { Result } from "slang-ts";
import type { ActionRef } from "../authoring/types";
import { runGateway } from "../execution/execution-gateway";
import { runHook } from "../execution/run-hooks";
import { applyPostStepGovernance } from "../oversight";
import { snapshotToJson, withEscalation } from "../state-space/task-state";
import { resolveNextStep } from "./resolve-next";
import { executionId, checkpointId } from "../shared/id";

const MAX_STEPS_PER_PHASE = 100;

export const runPhase = async ({
  phase,
  actionRegistry,
  state,
  getApprovalStatus,
  inputFor,
  store,
  communicate,
  remember,
  startIndex,
  startViaJump,
  agentSkills,
  storyline,
  diagnostics,
  guidanceEnabled = true,
}: RunPhaseInput): Promise<PhaseResult> => {
  // Resolve phase-level skills once. Each action may override with its own set.
  const phaseSkillsResult = resolveSkillRefs(phase.skills ?? [], agentSkills ?? []);
  if (phaseSkillsResult.isErr) {
    return {
      status: "failed",
      snapshot: state,
      failedReason: `phase "${phase.name}" skill resolution failed: ${phaseSkillsResult.error}`,
    };
  }
  const phaseSkills = await buildAvailableSkills(phaseSkillsResult.value);

  const phaseCtx: ActionContext = {
    taskId: state.taskId,
    executionId: executionId(),
    agentName: state.agentName,
    phase: phase.name,
    ...(phaseSkills.length > 0 ? { availableSkills: phaseSkills } : {}),
    ...(communicate !== undefined ? { communicate } : {}),
    ...(remember !== undefined ? { remember } : {}),
    ...(storyline !== undefined ? { storyline } : {}),
    ...(phase.storyline !== undefined ? { phaseStoryline: phase.storyline } : {}),
  };

  // Phase before hook — observes only, never authorizes (invariant 22, prohibition 17).
  const beforeResult = await runHook(phase.hooks?.before, phaseCtx);
  if (beforeResult.isErr) {
    return {
      status: "failed",
      snapshot: state,
      failedReason: `phase before-hook failed: ${beforeResult.error}`,
    };
  }

  let currentState: typeof state = { ...state, currentPhase: phase.name };
  let currentIndex = startIndex ?? 0;
  let stepCount = 0;
  const { actions } = phase;

  // Guard: if startIndex is at or past the action list, the phase is already
  // complete from a prior successful run up to that point — return completed
  // rather than silently skipping actions (prevents a stale failedIndex from a
  // shorter previous run path from corrupting re-runs).
  if (currentIndex >= actions.length) {
    return await completePhase(phase, phaseCtx, currentState, store);
  }

  // Set to true after a Branch routes to a named target via jump.
  // When the jump target (a plain string action) completes, the phase terminates
  // rather than continuing sequentially into the rest of the list.
  // If the target is itself a Branch, it may further route (and set this flag again).
  // A resume that re-enters at a persisted jump target (startViaJump) restores
  // the flag so the decision-tree semantics survive the pause/resume boundary.
  let afterJump = startIndex !== undefined ? (startViaJump ?? false) : false;

  while (currentIndex < actions.length && stepCount < MAX_STEPS_PER_PHASE) {
    stepCount++;
    const ref = actions[currentIndex]!;
    const isJumpTarget = afterJump;
    afterJump = false;

    // Guard check for Branch nodes — evaluated before the action runs.
    // A false guard skips this branch; no governance decision is made.
    if (typeof ref !== "string" && ref.when !== undefined && !ref.when(phaseCtx)) {
      currentIndex++;
      continue;
    }

    const actionName = typeof ref === "string" ? ref : ref.action;
    const actionOpt = option(actionRegistry.get(actionName));
    if (actionOpt.isNone) {
      await runHook(phase.hooks?.onError, phaseCtx);
      return {
        status: "failed",
        snapshot: currentState,
        failedAction: actionName,
        failedIndex: currentIndex,
        failedReason: `action "${actionName}" not found in action registry`,
      };
    }
    const action = actionOpt.value;

    let actionSkills = phaseSkills;
    if (action.skills !== undefined) {
      const actionSkillsResult = resolveSkillRefs(action.skills, agentSkills ?? []);
      if (actionSkillsResult.isErr) {
        await runHook(phase.hooks?.onError, phaseCtx);
        return {
          status: "failed",
          snapshot: currentState,
          failedAction: actionName,
          failedIndex: currentIndex,
          failedReason: `skill resolution failed for action "${actionName}": ${actionSkillsResult.error}`,
        };
      }
      actionSkills = await buildAvailableSkills(actionSkillsResult.value);
    }
    const gwResult = await runGateway({
      action,
      rawInput: inputFor(actionName),
      state: currentState,
      approvalStatus: getApprovalStatus(actionName),
      store,
      communicate,
      remember,
      ...(actionSkills.length > 0 ? { availableSkills: actionSkills } : {}),
      ...(storyline !== undefined ? { storyline } : {}),
      ...(phase.storyline !== undefined ? { phaseStoryline: phase.storyline } : {}),
      diagnostics,
    });

    if (gwResult.isErr) {
      // Gateway blocked before fn ran (schema invalid, not legal, no approval, hook failed).
      await runHook(phase.hooks?.onError, phaseCtx);
      return {
        status: "failed",
        snapshot: currentState,
        failedAction: actionName,
        failedIndex: currentIndex,
        failedReason: gwResult.error,
      };
    }

    const { fnResult, updatedSnapshot, surpriseMagnitude } = gwResult.value;
    currentState = updatedSnapshot;

    // Post-step governance differs by outcome, by design:
    //
    //   Success → full post-step governance (shared with the free reasoner loop):
    //     persist trust/risk and escalate if execution is drifting (high cost /
    //     low progress / Bayesian surprise). This catches a "succeeding but
    //     runaway" step that supervision would never see (supervision keys off
    //     phase *failure*).
    //
    //   Failure → persist the gateway's trust/risk update, but do NOT escalate
    //     here. A failed action is the supervision layer's domain (H1): its
    //     declared policy decides retry / restart / escalate / abort. Escalating
    //     from post-step would pre-empt that policy and make it unreachable, and
    //     a branch onFailure recovery route would never fire.
    if (fnResult.isOk) {
      const gov = await applyPostStepGovernance({
        taskId: currentState.taskId,
        snapshot: currentState,
        surpriseMagnitude,
        store,
        guidanceEnabled,
      });
      currentState = gov.snapshot;
      if (gov.kind === "escalated") {
        await runHook(phase.hooks?.onError, phaseCtx);
        // Persist a positional checkpoint before blocking, mirroring the
        // supervision-escalate path in run-workflow: resume re-enters this phase
        // AFTER the action that just succeeded, never re-running it. The
        // persisted snapshot clears the escalated flag — a human-initiated
        // resume is the oversight resolution, and the free reasoner loop's
        // resume checkpoint likewise predates the escalation flag.
        const resume = resolveResumePosition({ actions, currentIndex, fnResult, ctx: phaseCtx, isJumpTarget, ref });
        await store.saveCheckpoint({
          id: checkpointId(),
          taskId: currentState.taskId,
          phase: phase.name,
          state: snapshotToJson({
            ...withEscalation({ snapshot: currentState, escalated: false }),
            status: "paused",
            currentPhase: phase.name,
            currentActionIndex: resume.index,
            ...(resume.viaJump ? { currentActionViaJump: true } : {}),
          }),
          createdAt: new Date(),
        });
        return { status: "blocked", snapshot: currentState, reason: gov.reason };
      }
    } else {
      await store.updateTask(currentState.taskId, {
        risk: currentState.risk,
        trust: currentState.trust,
        updatedAt: new Date(),
      });
    }

    // Jump targets that are plain string refs terminate the phase immediately.
    // This enforces decision-tree semantics: a branch routes to exactly one
    // terminal step, not to all remaining sequential steps (invariant 21).
    if (isJumpTarget && typeof ref === "string") {
      if (fnResult.isOk) {
        return await completePhase(phase, phaseCtx, currentState, store);
      }
      await runHook(phase.hooks?.onError, phaseCtx);
      return {
        status: "failed",
        snapshot: currentState,
        failedAction: actionName,
        failedIndex: currentIndex,
        failedReason: fnResult.error,
      };
    }

    const next = resolveNextStep({
      actions,
      currentIndex,
      result: fnResult,
      ctx: phaseCtx,
    });

    if (next.kind === "end-success") {
      return await completePhase(phase, phaseCtx, currentState, store);
    }

    if (next.kind === "end-failure") {
      await runHook(phase.hooks?.onError, phaseCtx);
      return {
        status: "failed",
        snapshot: currentState,
        failedAction: actionName,
        failedIndex: currentIndex,
        failedReason: next.reason,
      };
    }

    currentIndex = next.nextIndex;
    afterJump = next.viaJump;
  }

  // Loop exited: either all actions ran naturally or step limit hit.
  if (stepCount >= MAX_STEPS_PER_PHASE) {
    await runHook(phase.hooks?.onError, phaseCtx);
    return {
      status: "failed",
      snapshot: currentState,
      failedReason: `phase "${phase.name}" exceeded ${MAX_STEPS_PER_PHASE}-step limit — possible cycle in declared transitions`,
    };
  }

  // All actions ran successfully.
  return await completePhase(phase, phaseCtx, currentState, store);
};

/**
 * Where a resume should re-enter the phase after a mid-phase escalation. The
 * escalated action already SUCCEEDED (post-step governance only runs on Ok), so
 * the resume position is the step that would have run next:
 *   - a plain-string jump target terminates the phase after its action, so the
 *     phase is effectively complete — resume past the end (the >= length guard
 *     in runPhase then completes it without re-running anything);
 *   - end-success likewise resumes past the end;
 *   - a continue resumes at its nextIndex, carrying the viaJump flag;
 *   - end-failure on an Ok result means an undeclared branch target (developer
 *     error) — re-enter at the same index so the declared-transition failure
 *     surfaces on resume instead of being silently swallowed.
 */
const resolveResumePosition = ({
  actions,
  currentIndex,
  fnResult,
  ctx,
  isJumpTarget,
  ref,
}: {
  actions: ActionRef[];
  currentIndex: number;
  fnResult: Result<unknown, string>;
  ctx: ActionContext;
  isJumpTarget: boolean;
  ref: ActionRef;
}): { index: number; viaJump: boolean } => {
  if (isJumpTarget && typeof ref === "string") return { index: actions.length, viaJump: false };
  const next = resolveNextStep({ actions, currentIndex, result: fnResult, ctx });
  if (next.kind === "continue") return { index: next.nextIndex, viaJump: next.viaJump };
  if (next.kind === "end-failure") return { index: currentIndex, viaJump: isJumpTarget };
  return { index: actions.length, viaJump: false };
};

/** Write the phase checkpoint and run the after hook, then return success. */
const completePhase = async (
  phase: RunPhaseInput["phase"],
  phaseCtx: ActionContext,
  snapshot: RunPhaseInput["state"],
  store: RunPhaseInput["store"],
): Promise<PhaseResult> => {
  // Record this phase as completed BEFORE the checkpoint is written, so the
  // persisted snapshot proves the phase finished. On resume, runWorkflow skips
  // every phase in completedPhases instead of re-running it (mid-workflow resume,
  // prevents double-execution of side-effectful phases).
  const advanced: RunPhaseInput["state"] = {
    ...snapshot,
    completedPhases: snapshot.completedPhases?.includes(phase.name)
      ? snapshot.completedPhases
      : [...(snapshot.completedPhases ?? []), phase.name],
  };

  // Always checkpoint — regardless of the declared `checkpoint` flag. A phase
  // that completed without one would leave the store's latest checkpoint stale;
  // a later blocked phase would then resume from BEFORE this phase and
  // re-execute its side effects (invariant 10: every recovery point is real).
  const ckpt: Checkpoint = {
    id: checkpointId(),
    taskId: advanced.taskId,
    phase: phase.name,
    state: snapshotToJson(advanced),
    createdAt: new Date(),
  };
  await store.saveCheckpoint(ckpt);

  await runHook(phase.hooks?.after, phaseCtx);
  return { status: "completed", snapshot: advanced };
};
