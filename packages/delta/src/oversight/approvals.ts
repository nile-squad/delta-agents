/**
 * Approval request lifecycle — create, resolve, and query.
 *
 * Approvals gate execution for actions that declare requiresApproval: true.
 * The execution gateway consumes an ApprovalStatus at call time; the functions
 * here produce and mutate that status so callers can bridge the two.
 *
 * Flow:
 *   requestApproval() → saves a "pending" ApprovalRequest to the store
 *   resolveApproval()  → moves status to "approved" or "rejected"
 *   getApprovalStatusForAction() → returns the current status the gateway needs
 *
 * A rejected approval permanently blocks execution for that (taskId, action)
 * pair until a new approval request is created. The engine never silently
 * re-opens a rejected approval (spec §Human Oversight, prohibition 11).
 *
 * Covers: invariant 13 (auditable), prohibition 11 (no execution after rejection).
 */

import { Ok, Err, option } from "slang-ts";
import type { Result } from "slang-ts";
import type { ApprovalRequest } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ApprovalStatus } from "../execution/types";
import type { Action } from "../authoring/types";
import { approvalId } from "../shared/id";

/**
 * Whether an action's `requiresApproval` declaration gates execution at all.
 * `true` and the `{ untilTrust }` waiver shape both require approval — the
 * waiver only changes HOW the approval is obtained (auto-approved once the
 * task's trust reaches the threshold), never whether the gate exists. The
 * execution gateway uses this so a waived action still needs an "approved"
 * status on record before it runs.
 */
export const approvalRequired = (requiresApproval: Action["requiresApproval"]): boolean =>
  requiresApproval === true || typeof requiresApproval === "object";

/**
 * Create a new pending approval request for an action that requires human sign-off.
 * The caller should pass this record's id to resolveApproval once the human decides.
 */
export const requestApproval = async ({
  taskId,
  action,
  reason,
  store,
}: {
  taskId: string;
  action: string;
  reason: string;
  store: StoragePort;
}): Promise<Result<ApprovalRequest, string>> => {
  const req: ApprovalRequest = {
    id: approvalId(),
    taskId,
    action,
    reason,
    status: "pending",
    createdAt: new Date(),
  };
  const saved = await store.saveApprovalRequest(req);
  if (saved.isErr) return Err(`failed to request approval for action "${action}": ${saved.error}`);
  return Ok(req);
};

/**
 * Record a trust-based auto-approval: an ApprovalRequest saved directly in the
 * "approved" state. Used when an action declares `requiresApproval:
 * { untilTrust }` and the task's trust score has reached the threshold — the
 * waiver never skips the record, so every auto-approved execution stays
 * auditable exactly like a human-approved one (invariant 13). `reason` should
 * name the trust score and threshold that justified the waiver.
 */
export const recordAutoApproval = async ({
  taskId,
  action,
  reason,
  store,
}: {
  taskId: string;
  action: string;
  reason: string;
  store: StoragePort;
}): Promise<Result<ApprovalRequest, string>> => {
  const req: ApprovalRequest = {
    id: approvalId(),
    taskId,
    action,
    reason,
    status: "approved",
    createdAt: new Date(),
  };
  const saved = await store.saveApprovalRequest(req);
  if (saved.isErr) return Err(`failed to record auto-approval for action "${action}": ${saved.error}`);
  return Ok(req);
};

/**
 * Resolve a pending approval to "approved" or "rejected".
 * Returns the updated ApprovalRequest so the caller can inspect the decision.
 * `reason` is the reviewer's stated ground for a rejection — persisted on the
 * record (rejectionReason) so the engine can feed it back to the model, which
 * can then route around the rejection instead of blindly retrying.
 */
export const resolveApproval = async ({
  approvalId: id,
  decision,
  reason,
  store,
}: {
  approvalId: string;
  decision: "approved" | "rejected";
  reason?: string;
  store: StoragePort;
}): Promise<Result<ApprovalRequest, string>> => {
  const reasonOpt = option(decision === "rejected" ? reason : undefined);
  const result = await store.updateApprovalRequest(id, {
    status: decision,
    ...(reasonOpt.isSome ? { rejectionReason: reasonOpt.value } : {}),
  });
  if (result.isErr) return Err(`failed to resolve approval "${id}": ${result.error}`);
  return Ok(result.value);
};

/**
 * Describe the latest rejection for a (taskId, action) pair, including the
 * reviewer's stated reason when one was recorded. Used to compose the feedback
 * the model (free loop) or the caller (workflow pre-flight) sees — a rejection
 * is final (prohibition 11), so the message must carry enough context to route
 * around it, not to retry it. Best-effort: a store failure or a missing record
 * degrades to the bare description, never an error.
 */
export const describeRejection = async ({
  taskId,
  action,
  store,
}: {
  taskId: string;
  action: string;
  store: StoragePort;
}): Promise<string> => {
  const base = `action "${action}" was rejected by a human reviewer`;
  const allResult = await store.getApprovalsByTask(taskId);
  if (allResult.isErr) return base;
  // Latest rejected request for this action (last by insertion order).
  const rejected = allResult.value.filter((a) => a.action === action && a.status === "rejected");
  const latestOpt = option(rejected[rejected.length - 1]);
  if (latestOpt.isNone) return base;
  const reasonOpt = option(latestOpt.value.rejectionReason);
  return reasonOpt.isSome ? `${base}: ${reasonOpt.value}` : base;
};

/**
 * Retrieve a single approval request by id.
 * Useful for callers that stored the id from requestApproval and need to re-read state.
 */
export const getApproval = async ({
  approvalId: id,
  store,
}: {
  approvalId: string;
  store: StoragePort;
}): Promise<Result<ApprovalRequest, string>> => {
  const result = await store.getApprovalRequest(id);
  if (result.isErr) return Err(`approval "${id}" not found: ${result.error}`);
  return Ok(result.value);
};

/**
 * Determine the current ApprovalStatus for a (taskId, action) pair.
 *
 * Returns the status of the most recent approval request for the given action.
 * "none" when no request exists. The execution gateway reads this to decide
 * whether to proceed or block (requiresApproval gate).
 *
 * When the store is unavailable, returns Err — the gateway must not proceed on
 * uncertainty (prohibitions 12, 13: never assume trust or safety without verification).
 */
export const getApprovalStatusForAction = async ({
  taskId,
  action,
  store,
}: {
  taskId: string;
  action: string;
  store: StoragePort;
}): Promise<Result<ApprovalStatus, string>> => {
  const allResult = await store.getApprovalsByTask(taskId);
  if (allResult.isErr) {
    return Err(`cannot determine approval status for action "${action}" on task "${taskId}": ${allResult.error}`);
  }
  // Find the most recent request for this action (last by insertion order).
  const forAction = allResult.value.filter((a) => a.action === action);
  if (forAction.length === 0) return Ok("none");
  const latest = forAction[forAction.length - 1]!;
  return Ok(latest.status);
};
