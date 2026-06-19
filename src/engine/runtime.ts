/**
 * Engine runtime — the send loop and lifecycle operations.
 *
 * runSendLoop is the core: it drives the reasoner → gateway → snapshot cycle
 * until the reasoner has no more actions to request or the task is blocked.
 * Every iteration is a governed step: discovery filters the action space,
 * the gateway enforces schema / legality / approval / budget, and the snapshot
 * accumulates evidence for trust and risk updates.
 *
 * pauseTask / resumeTask pair:
 *   pause saves the latest checkpoint and marks the task "paused".
 *   resume reads that checkpoint, rebuilds the snapshot, and re-enters the loop.
 *   The two can be called independently — pause is safe to call on any running
 *   or blocked task; resume expects a "paused" task with at least one checkpoint.
 *
 * inspectTask returns a complete, auditable view of the task's governance state.
 * Every record is TaskID-attributable (invariants 1, 8, 9, 13).
 */

import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import type { Task, Checkpoint, ApprovalRequest } from "../shared/types";
import type { JsonRecord } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort } from "../ports/reasoner-port";
import type { Registry } from "../authoring/registry";
import type { Agent } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { SendResult, InspectResult } from "./types";
import { snapshotFromTask } from "../state-space/task-state";
import { withEscalation } from "../state-space/task-state";
import { discoverActions } from "../state-space/discover-actions";
import { runGateway } from "../execution/execution-gateway";
import { checkEscalation, raiseEscalation, getApprovalStatusForAction, requestApproval } from "../oversight";
import { resolveApproval } from "../oversight";
import { checkpointId } from "../shared/id";

const MAX_STEPS_DEFAULT = 100;

// ── Snapshot serialisation ────────────────────────────────────────────────────

const snapshotToJson = (snapshot: TaskStateSnapshot): JsonRecord =>
  JSON.parse(JSON.stringify(snapshot)) as JsonRecord;

const snapshotFromJson = (json: JsonRecord): TaskStateSnapshot =>
  json as unknown as TaskStateSnapshot;

// ── Core send loop ────────────────────────────────────────────────────────────

/**
 * Drives the reasoner → gateway cycle until the task is done, blocked, or
 * the step limit is hit.
 *
 * A checkpoint is written to the store after every successful action so that
 * pause/resume always has a recent recoverable state.
 */
export const runSendLoop = async ({
  task,
  agent,
  reasoner,
  registry,
  store,
  maxSteps = MAX_STEPS_DEFAULT,
  startingSnapshot,
}: {
  task: Task;
  agent: Agent;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
  maxSteps?: number;
  startingSnapshot?: TaskStateSnapshot;
}): Promise<SendResult> => {
  let snapshot: TaskStateSnapshot = startingSnapshot ?? snapshotFromTask(task);
  let naturalExit = false;

  for (let step = 0; step < maxSteps; step++) {
    // ── 1. Discover legal actions for the agent in the current state ──────
    const agentActionsResult = registry.getActionsForAgent(agent.name);
    if (agentActionsResult.isErr) {
      return { taskId: task.id, status: "failed", snapshot, reason: agentActionsResult.error };
    }
    const discovery = discoverActions({ agentActions: agentActionsResult.value, state: snapshot });

    // No discoverable actions — all work is done (or blocked by prerequisites the
    // reasoner cannot advance). Treat as natural completion.
    if (discovery.available.length === 0) {
      naturalExit = true;
      break;
    }

    // ── 2. Ask the reasoner what to do next ──────────────────────────────
    const reasonResult = await reasoner.reason({
      task: { ...task, risk: snapshot.risk, trust: snapshot.trust, updatedAt: new Date() },
      availableActions: discovery.available.map((a) => a.name),
      agentRole: agent.role,
      rolePrompt: agent.rolePrompt,
    });

    // Reasoner exhausted or cannot propose anything — natural completion.
    if (reasonResult.isErr) {
      naturalExit = true;
      break;
    }

    const { actionName, input } = reasonResult.value;

    // ── 3. Look up the action definition ────────────────────────────────
    const actionResult = registry.getAction(actionName);
    if (actionResult.isErr) {
      await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
      return {
        taskId: task.id,
        status: "failed",
        snapshot,
        reason: `reasoner requested unknown action "${actionName}"`,
      };
    }
    const action = actionResult.value;

    // ── 4. Resolve approval status ───────────────────────────────────────
    const approvalStatusResult = await getApprovalStatusForAction({
      taskId: task.id,
      action: actionName,
      store,
    });
    let approvalStatus = approvalStatusResult.isOk ? approvalStatusResult.value : "none";

    // Auto-request approval when the action requires it and no request exists yet.
    // The task then blocks so the human can resolve before the loop continues.
    if (action.requiresApproval === true && approvalStatus === "none") {
      const reqResult = await requestApproval({
        taskId: task.id,
        action: actionName,
        reason: `action "${actionName}" requires human approval before execution`,
        store,
      });
      const approvalIdStr = reqResult.isOk ? reqResult.value.id : "(unavailable)";
      await store.updateTask(task.id, { status: "paused", updatedAt: new Date() });
      return {
        taskId: task.id,
        status: "blocked",
        snapshot,
        reason: `approval-required: action "${actionName}" needs human sign-off — approval id: ${approvalIdStr}`,
      };
    }

    // ── 5. Run through the execution gateway ────────────────────────────
    const gwResult = await runGateway({ action, rawInput: input, state: snapshot, approvalStatus, store });

    if (gwResult.isErr) {
      const isApprovalBlock = gwResult.error.startsWith("approval-required:");
      if (isApprovalBlock) {
        await store.updateTask(task.id, { status: "paused", updatedAt: new Date() });
        return { taskId: task.id, status: "blocked", snapshot, reason: gwResult.error };
      }
      await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
      return { taskId: task.id, status: "failed", snapshot, reason: gwResult.error };
    }

    const { fnResult, updatedSnapshot } = gwResult.value;
    snapshot = updatedSnapshot;

    // ── 6. Escalation check ─────────────────────────────────────────────
    const escCheck = checkEscalation({
      risk: snapshot.risk,
      spent: snapshot.spent,
      budget: snapshot.budget,
    });
    if (escCheck.escalate) {
      await raiseEscalation({
        taskId: task.id,
        trigger: escCheck.trigger,
        reason: escCheck.reason,
        store,
      });
      snapshot = withEscalation({ snapshot, escalated: true });
    }

    // ── 7. Checkpoint after successful action ────────────────────────────
    // Written unconditionally so pause/resume always has a recent recovery point.
    if (fnResult.isOk) {
      const ckpt: Checkpoint = {
        id: checkpointId(),
        taskId: task.id,
        state: snapshotToJson(snapshot),
        createdAt: new Date(),
      };
      await store.saveCheckpoint(ckpt);
    }

    // ── 8. Persist updated governance state ─────────────────────────────
    await store.updateTask(task.id, {
      risk: snapshot.risk,
      trust: snapshot.trust,
      updatedAt: new Date(),
    });
  }

  if (!naturalExit) {
    await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
    return {
      taskId: task.id,
      status: "failed",
      snapshot,
      reason: `task exceeded ${maxSteps}-step limit`,
    };
  }

  await store.updateTask(task.id, { status: "completed", updatedAt: new Date() });
  return { taskId: task.id, status: "completed", snapshot };
};

// ── Lifecycle operations ──────────────────────────────────────────────────────

/**
 * Pause a task: save its current state as a checkpoint and mark it "paused".
 * The most recent checkpoint is used by resumeTask to restore the snapshot.
 */
export const pauseTask = async ({
  taskId,
  store,
}: {
  taskId: string;
  store: StoragePort;
}): Promise<Result<void, string>> => {
  const taskResult = await store.getTask(taskId);
  if (taskResult.isErr) return Err(`cannot pause: task "${taskId}" not found`);
  const task = taskResult.value;

  // Build the best available snapshot from the task record.
  // completedActions / spent live in the latest checkpoint if one exists.
  const latestCkpt = await store.getLatestCheckpoint(taskId);
  const snapshot: TaskStateSnapshot = latestCkpt.isOk && latestCkpt.value !== null
    ? snapshotFromJson(latestCkpt.value.state)
    : snapshotFromTask(task);

  // Save a checkpoint capturing the paused state.
  const ckpt: Checkpoint = {
    id: checkpointId(),
    taskId,
    state: snapshotToJson({ ...snapshot, status: "paused" }),
    createdAt: new Date(),
  };
  const saveResult = await store.saveCheckpoint(ckpt);
  if (saveResult.isErr) return Err(`failed to save checkpoint on pause: ${saveResult.error}`);

  const updateResult = await store.updateTask(taskId, { status: "paused", updatedAt: new Date() });
  if (updateResult.isErr) return Err(`failed to update task status to "paused": ${updateResult.error}`);

  return Ok(undefined);
};

/**
 * Resume a paused or blocked task from its latest checkpoint.
 * Rebuilds the TaskStateSnapshot from the checkpoint, re-enters the send loop.
 */
export const resumeTask = async ({
  taskId,
  agent,
  reasoner,
  registry,
  store,
  maxSteps,
}: {
  taskId: string;
  agent: Agent;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
  maxSteps?: number;
}): Promise<Result<SendResult, string>> => {
  const taskResult = await store.getTask(taskId);
  if (taskResult.isErr) return Err(`cannot resume: task "${taskId}" not found`);
  const task = taskResult.value;

  if (task.status !== "paused" && task.status !== "pending") {
    return Err(`cannot resume task "${taskId}" — current status is "${task.status}" (expected "paused")`);
  }

  const ckptResult = await store.getLatestCheckpoint(taskId);
  if (ckptResult.isErr) return Err(`cannot resume: checkpoint read failed: ${ckptResult.error}`);

  const startingSnapshot: TaskStateSnapshot =
    ckptResult.value !== null
      ? { ...snapshotFromJson(ckptResult.value.state), status: "running" as const }
      : { ...snapshotFromTask(task), status: "running" as const };

  const updateResult = await store.updateTask(taskId, { status: "running", updatedAt: new Date() });
  if (updateResult.isErr) return Err(`failed to mark task as running: ${updateResult.error}`);

  const result = await runSendLoop({ task, agent, reasoner, registry, store, maxSteps, startingSnapshot });
  return Ok(result);
};

/**
 * Return the full governance audit state for a task.
 * All collections are TaskID-attributable (invariants 1, 8, 9, 13).
 */
export const inspectTask = async ({
  taskId,
  store,
}: {
  taskId: string;
  store: StoragePort;
}): Promise<Result<InspectResult, string>> => {
  const taskResult = await store.getTask(taskId);
  if (taskResult.isErr) return Err(`inspect failed: task "${taskId}" not found`);

  const [execsResult, ckptResult, escsResult, approvalsResult] = await Promise.all([
    store.getExecutionsByTask(taskId),
    store.getLatestCheckpoint(taskId),
    store.getEscalationsByTask(taskId),
    store.getPendingApprovals(taskId),
  ]);

  if (execsResult.isErr) return Err(`inspect failed: cannot load executions: ${execsResult.error}`);
  if (ckptResult.isErr) return Err(`inspect failed: cannot load checkpoint: ${ckptResult.error}`);
  if (escsResult.isErr) return Err(`inspect failed: cannot load escalations: ${escsResult.error}`);
  if (approvalsResult.isErr) return Err(`inspect failed: cannot load approvals: ${approvalsResult.error}`);

  return Ok({
    task: taskResult.value,
    executions: execsResult.value,
    latestCheckpoint: ckptResult.value,
    escalations: escsResult.value,
    pendingApprovals: approvalsResult.value,
  });
};

// Re-export resolveApproval for the approve() facade method.
export { resolveApproval };
