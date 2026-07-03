/**
 * Shared post-step governance — the per-action work that must happen identically
 * no matter which executor ran the action (the free reasoner loop or the
 * deterministic workflow runner).
 *
 * Both paths, after a successful gateway step, must:
 *   1. check escalation against the updated risk + surprise + budget signals,
 *   2. on escalation, record it and pause the task (await human oversight),
 *   3. otherwise persist the updated risk/trust to the task record.
 *
 * Extracting this into one function is a correctness property, not just DRY: if
 * the two executors computed escalation or persisted governance state
 * differently, a task's audit trail and safety behaviour would depend on which
 * path ran it. One helper guarantees they cannot diverge (context.md audit: the
 * workflow path previously had no escalation or trust/risk persistence at all).
 */

import type { StoragePort } from "../ports/storage-port";
import type { TaskStateSnapshot } from "../state-space/types";
import { withEscalation } from "../state-space/task-state";
import { checkEscalation } from "./escalation";
import { raiseEscalation } from "./escalation";

export type PostStepGovernance =
  | { kind: "continue"; snapshot: TaskStateSnapshot }
  | { kind: "escalated"; snapshot: TaskStateSnapshot; reason: string };

/**
 * Apply escalation + governance persistence after one successful action.
 *
 * Returns "escalated" (task paused, escalation recorded) or "continue" (risk/trust
 * persisted, task may proceed). The caller stops on "escalated" and surfaces the
 * task as blocked — an escalated task awaits human oversight and must never be
 * reported as completed (spec §Human Oversight, invariant 13).
 */
export const applyPostStepGovernance = async ({
  taskId,
  snapshot,
  surpriseMagnitude,
  store,
}: {
  taskId: string;
  snapshot: TaskStateSnapshot;
  surpriseMagnitude: number;
  store: StoragePort;
}): Promise<PostStepGovernance> => {
  const escCheck = checkEscalation({
    risk: snapshot.risk,
    spent: snapshot.spent,
    budget: snapshot.budget,
    surpriseMagnitude,
    trust: snapshot.trust,
  });

  if (escCheck.escalate) {
    await raiseEscalation({ taskId, trigger: escCheck.trigger, reason: escCheck.reason, store });
    const escalated = withEscalation({ snapshot, escalated: true });
    await store.updateTask(taskId, {
      risk: escalated.risk,
      trust: escalated.trust,
      status: "paused",
      updatedAt: new Date(),
    });
    return { kind: "escalated", snapshot: escalated, reason: `escalated: ${escCheck.reason}` };
  }

  await store.updateTask(taskId, {
    risk: snapshot.risk,
    trust: snapshot.trust,
    updatedAt: new Date(),
  });
  return { kind: "continue", snapshot };
};
