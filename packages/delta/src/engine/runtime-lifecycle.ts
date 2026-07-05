/**
 * Engine runtime lifecycle operations — pause / resume / inspect.
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
import type { Checkpoint } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort } from "../ports/reasoner-port";
import type { Registry } from "../authoring/registry";
import type { Agent } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { RetryOptions } from "../infra";
import type { SendResult, InspectResult } from "./types";
import { snapshotFromTask, snapshotFromJson, snapshotToJson } from "../state-space/task-state";
import { checkpointId } from "../shared/id";
import type { Logger } from "../shared/logger-types";
import type { Diagnostics } from "../shared/diagnostics";
import type { DeltaEventsInternal } from "../shared/create-events";
import { runCommitStep } from "./commit-step";
import { runSendLoop, runWorkflowTask } from "./runtime";

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

  // A terminal task is finished — pausing it would let a later resume re-enter
  // the loop and re-run completed work, resurrecting a done task (M1). Reject so
  // a terminal status stays terminal (keeps the C1–C4 "honest status" property).
  if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
    return Err(`cannot pause task "${taskId}" — it is already "${task.status}" (terminal)`);
  }

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
  providerRetry,
  timezone,
  logger,
  diagnostics,
  events,
  commitContextLimit,
  maxInvalidDecisionRetries,
}: {
  taskId: string;
  agent: Agent;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
  maxSteps?: number;
  providerRetry?: RetryOptions;
  /** Timezone for humanized time in reasoner user messages; falls back to system tz in the scheduler. */
  timezone?: string;
  /** Per-engine logger threaded from the engine factory. */
  logger: Logger;
  /** Per-engine diagnostics handle. Threaded into the scheduler so opt-in
   * modules can emit structured events. */
  diagnostics: Diagnostics;
  /** Per-engine events emitter. Threaded so HITL and task lifecycle events fire unconditionally. */
  events: DeltaEventsInternal;
  /** Max recent commits to inject into reasoner context. */
  commitContextLimit?: number;
  /** Max consecutive invalid model decisions fed back for correction before failing. */
  maxInvalidDecisionRetries?: number;
}): Promise<Result<SendResult, string>> => {
  const taskResult = await store.getTask(taskId);
  if (taskResult.isErr) return Err(`cannot resume: task "${taskId}" not found`);
  const task = taskResult.value;

  const ckptResult = await store.getLatestCheckpoint(taskId);
  if (ckptResult.isErr) return Err(`cannot resume: checkpoint read failed: ${ckptResult.error}`);

  const startingSnapshot: TaskStateSnapshot =
    ckptResult.value !== null
      ? { ...snapshotFromJson(ckptResult.value.state), status: "running" as const }
      : { ...snapshotFromTask(task), status: "running" as const };

  // Compare-and-swap is the resume gate: exactly one caller can move the task
  // to "running". A concurrent resume() — or a task in any other state — loses
  // the swap and gets Err, so two resumes can never both drive the same task.
  // The branches below key off the PRE-transition status read above.
  const transitionResult = await store.transitionTaskStatus(taskId, ["paused", "pending", "pendingCommit"], "running");
  if (transitionResult.isErr) {
    return Err(`cannot resume task "${taskId}": ${transitionResult.error} (a concurrent resume may already be driving it)`);
  }

  // A pendingCommit task resumes directly into the commit step — the workflow
  // already completed, we just need the agent to acknowledge. Must be checked
  // BEFORE the workflow branch because a pendingCommit task has its workflow
  // set, but re-running the workflow would double-execute completed phases.
  if (task.status === "pendingCommit") {
    const commitResult = await runCommitStep({
      task,
      agent,
      reasoner,
      store,
      workflowName: task.workflow ?? "",
      snapshot: startingSnapshot,
      providerRetry,
      timezone,
      logger,
      diagnostics,
    });
    if (commitResult.status === "completed") {
      events.emit("task-completed", { taskId: task.id, agentName: agent.name, goal: task.goal });
    } else if (commitResult.status === "blocked") {
      events.emit("task-blocked", { taskId: task.id, agentName: agent.name, reason: commitResult.reason ?? "unknown" });
    } else {
      events.emit("task-failed", { taskId: task.id, agentName: agent.name, reason: commitResult.reason ?? "unknown" });
    }
    return Ok(commitResult);
  }

  // C-a coexistence holds on resume too: a workflow task re-enters the
  // deterministic workflow engine (reasoner-less), NOT the reasoner loop. The
  // reconstructed snapshot carries completedPhases (finished phases are skipped)
  // and the persisted send-time input, so the workflow resumes faithfully from
  // the latest checkpoint instead of restarting reasoning from scratch.
  if (task.workflow !== undefined) {
    const result = await runWorkflowTask({
      task,
      agent,
      workflowName: task.workflow,
      input: startingSnapshot.workflowInput,
      actionInputs: startingSnapshot.workflowActionInputs,
      registry,
      store,
      startingSnapshot,
      reasoner,
      providerRetry,
      timezone,
      logger,
      diagnostics,
      events,
    });
    return Ok(result);
  }

  const result = await runSendLoop({ task, agent, reasoner, registry, store, maxSteps, startingSnapshot, providerRetry, timezone, logger, diagnostics, events, commitContextLimit, maxInvalidDecisionRetries });
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
