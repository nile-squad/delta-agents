/**
 * Supervision module types.
 *
 * SupervisionDecision is the output of applyStrategy — a deterministic verdict
 * derived from the declared policy, the retry count, and whether a checkpoint
 * is available. The engine acts on this verdict without further interpretation.
 *
 * SlotResult and ReleaseResult are the pure-function return types from the
 * task-tree slot manager.
 */

import type { TaskTree } from "../shared/types";

/**
 * The verdict produced by applyStrategy after a task failure.
 * The engine executes this decision without deviation (prohibition 10).
 *
 * give-up: maxRetries exhausted — no further automatic recovery is possible.
 * resume: checkpoint available — recover from the last recorded state.
 */
export type SupervisionDecision =
  | { action: "retry" }
  | { action: "restart" }
  | { action: "resume"; checkpointId: string }
  | { action: "escalate" }
  | { action: "abort-subtree" }
  | { action: "abort-tree" }
  | { action: "give-up"; reason: string };

/** Outcome of requesting a slot for a new subtask. */
export type SlotResult =
  | { granted: true; tree: TaskTree }
  | { queued: true; tree: TaskTree };

/** Outcome of releasing a subtask's slot. */
export type ReleaseResult = {
  tree: TaskTree;
  /** The task ID promoted from queuedChildren to activeChildren, if any. */
  promoted: string | undefined;
};
