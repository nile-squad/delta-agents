/**
 * Next-step resolver — pure deterministic routing.
 *
 * After each action execution, the runner calls resolveNextStep to determine
 * what happens next. The result is one of three things:
 *   - continue at a specific index (jump or advance)
 *   - end-success (phase complete)
 *   - end-failure (phase failed, with reason)
 *
 * All decisions are derived entirely from declared transitions and the
 * observed action outcome. No new paths are invented at runtime.
 *
 * Covers: invariant 21 (branching = declared transitions + observed outcomes);
 *         prohibition 19 (engine never invents a transition).
 */

import type { Result } from "slang-ts";
import type { ActionRef, ActionContext } from "../authoring/types";
import type { NextStep } from "./types";

/**
 * Find the position of a named action in the actions list.
 * Matches both string refs and Branch nodes by their action name.
 * Returns -1 when no match found — caller must treat this as undeclared.
 */
export const findActionIndex = (actions: ActionRef[], name: string): number =>
  actions.findIndex((ref) =>
    typeof ref === "string" ? ref === name : ref.action === name,
  );

/**
 * Resolve the next step after the action at currentIndex completed with result.
 *
 * Sequential (string ref):
 *   Ok  → continue to index + 1 (or end-success at list end)
 *   Err → end-failure with the fn's error
 *
 * Conditional (Branch ref):
 *   Ok  + onSuccess declared → continue to the named action's index
 *   Ok  + no onSuccess       → end-success
 *   Err + onFailure declared → continue to the named action's index
 *   Err + no onFailure       → end-failure
 *
 * If a named target is not found in the actions list, that is a developer
 * error (undeclared transition) — returns end-failure with an explanatory reason.
 */
export const resolveNextStep = ({
  actions,
  currentIndex,
  result,
  ctx: _ctx,
}: {
  actions: ActionRef[];
  currentIndex: number;
  result: Result<unknown, string>;
  /** Available for future guard evaluation extensions. Unused in this function. */
  ctx: ActionContext;
}): NextStep => {
  const ref = actions[currentIndex];
  if (ref === undefined) {
    return { kind: "end-failure", reason: `no action at index ${currentIndex}` };
  }

  if (typeof ref === "string") {
    if (result.isErr) {
      return { kind: "end-failure", reason: result.error };
    }
    const nextIndex = currentIndex + 1;
    return nextIndex >= actions.length
      ? { kind: "end-success" }
      : { kind: "continue", nextIndex, viaJump: false };
  }

  // Branch node — all named-target routes are jumps (decision-tree semantics).
  if (result.isOk) {
    if (ref.onSuccess === undefined) {
      return { kind: "end-success" };
    }
    const idx = findActionIndex(actions, ref.onSuccess);
    if (idx === -1) {
      return {
        kind: "end-failure",
        reason: `branch onSuccess target "${ref.onSuccess}" is not declared in this phase's action list (prohibition 19: engine never invents undeclared transitions)`,
      };
    }
    return { kind: "continue", nextIndex: idx, viaJump: true };
  }

  // Err outcome from branch action
  if (ref.onFailure === undefined) {
    return { kind: "end-failure", reason: result.error };
  }
  const idx = findActionIndex(actions, ref.onFailure);
  if (idx === -1) {
    return {
      kind: "end-failure",
      reason: `branch onFailure target "${ref.onFailure}" is not declared in this phase's action list (prohibition 19: engine never invents undeclared transitions)`,
    };
  }
  return { kind: "continue", nextIndex: idx, viaJump: true };
};
