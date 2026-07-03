/**
 * Markov legality check — pure function.
 *
 * Determines whether an action is legal in the current task state.
 * The decision depends solely on the current TaskStateSnapshot — no
 * historical replay, no external I/O (spec §Markov Constraints).
 *
 * Structural checks performed here:
 *   1. Task is in an executable status ("running")
 *   2. Budget has not been exhausted
 *   3. Parent budget is not exhausted (for subtasks)
 *   4. Risk is not currently escalated (awaiting human oversight)
 *   5. All declared prerequisites are satisfied
 *
 * Authorization and approval checks live in the execution gateway (Phase 4)
 * where they are the final enforcement point before fn() is called. Discovery
 * only needs structural legality — the gateway enforces everything.
 */

import type { Action } from "../authoring/types";
import type { TaskStateSnapshot, LegalityResult } from "./types";
import { isOverBudget } from "../shared/cost";
import { evaluatePrerequisites } from "./evaluate-prerequisites";

export const checkLegality = ({
  action,
  state,
}: {
  action: Action;
  state: TaskStateSnapshot;
}): LegalityResult => {
  // 1. Task must be actively running. Paused, aborted, completed, and failed
  //    tasks do not permit further action execution.
  if (state.status !== "running") {
    return {
      legal: false,
      reason: `task "${state.taskId}" is "${state.status}" — actions can only execute when status is "running"`,
    };
  }

  // 2. Own budget must not be exhausted.
  if (isOverBudget(state.spent, state.budget)) {
    return {
      legal: false,
      reason: `task "${state.taskId}" has exhausted its budget`,
    };
  }

  // 3. Parent budget must not be exhausted (subtask scoping — invariant 18).
  if (
    state.parentBudget !== undefined &&
    state.parentSpent !== undefined &&
    isOverBudget(state.parentSpent, state.parentBudget)
  ) {
    return {
      legal: false,
      reason: `task "${state.taskId}" parent budget is exhausted — subtask cannot exceed parent scope`,
    };
  }

  // 4. Escalated tasks await human oversight before any further execution.
  if (state.risk.escalated) {
    return {
      legal: false,
      reason: `task "${state.taskId}" is escalated — awaiting human oversight before continuing`,
    };
  }

  // 5. All declared prerequisites must be satisfied.
  const prereq = evaluatePrerequisites({ action, state });
  if (!prereq.satisfied) {
    return { legal: false, reason: prereq.reason };
  }

  return { legal: true };
};
