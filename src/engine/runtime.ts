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
import type { Agent, Action, Workflow } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { ApprovalStatus } from "../execution/types";
import type { SendResult, InspectResult } from "./types";
import { snapshotFromTask } from "../state-space/task-state";
import { isOverBudget } from "../shared/cost";
import { discoverActions } from "../state-space/discover-actions";
import { runGateway } from "../execution/execution-gateway";
import { runWorkflow } from "../workflow";
import { applyPostStepGovernance, getApprovalStatusForAction, requestApproval } from "../oversight";
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

    // An Err is a genuine model/API failure or safety refusal — never completion.
    // A failed reasoner is not a finished task (spec §Execution Outcomes).
    if (reasonResult.isErr) {
      await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
      return {
        taskId: task.id,
        status: "failed",
        snapshot,
        reason: `reasoner failed: ${reasonResult.error}`,
      };
    }

    const decision = reasonResult.value;

    // Explicit completion signal — the goal is satisfied, no further action.
    if (decision.kind === "done") {
      naturalExit = true;
      break;
    }

    const { actionName, input, reasoningCost } = decision.request;

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
    const gwResult = await runGateway({ action, rawInput: input, state: snapshot, approvalStatus, store, reasoningCost, stepIndex: step });

    if (gwResult.isErr) {
      const isApprovalBlock = gwResult.error.startsWith("approval-required:");
      if (isApprovalBlock) {
        await store.updateTask(task.id, { status: "paused", updatedAt: new Date() });
        return { taskId: task.id, status: "blocked", snapshot, reason: gwResult.error };
      }
      await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
      return { taskId: task.id, status: "failed", snapshot, reason: gwResult.error };
    }

    const { fnResult, updatedSnapshot, surpriseMagnitude } = gwResult.value;
    snapshot = updatedSnapshot;

    // ── 6. Post-step governance (escalation + persistence) ──────────────
    // Shared with the workflow path so both executors govern identically. On
    // escalation the task is paused and surfaced as blocked — never completed
    // (spec §Human Oversight, invariant 13, §Bayesian Surprise).
    const gov = await applyPostStepGovernance({ taskId: task.id, snapshot, surpriseMagnitude, store });
    snapshot = gov.snapshot;
    if (gov.kind === "escalated") {
      return { taskId: task.id, status: "blocked", snapshot, reason: gov.reason };
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

  // A task that stopped while over budget did not finish cleanly — completion
  // would misreport an exhausted run as success (spec §Cost Friction Detection).
  if (isOverBudget(snapshot.spent, snapshot.budget)) {
    await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
    return {
      taskId: task.id,
      status: "failed",
      snapshot,
      reason: "task halted with budget exhausted",
    };
  }

  await store.updateTask(task.id, { status: "completed", updatedAt: new Date() });
  return { taskId: task.id, status: "completed", snapshot };
};

// ── Workflow task driver (C-a) ──────────────────────────────────────────────

/** Collect every action name referenced by a workflow's phases (string refs and
 * branch targets). Used to pre-flight approvals before the workflow runs. */
const collectWorkflowActionNames = (workflow: Workflow): string[] => {
  const names = new Set<string>();
  for (const phase of workflow.phases) {
    for (const ref of phase.actions) {
      if (typeof ref === "string") {
        names.add(ref);
      } else {
        names.add(ref.action);
        if (ref.onSuccess !== undefined) names.add(ref.onSuccess);
        if (ref.onFailure !== undefined) names.add(ref.onFailure);
      }
    }
  }
  return [...names];
};

/**
 * Drive a task that has an assigned workflow through the deterministic workflow
 * engine (C-a coexistence model). The reasoner is not consulted: the phases run
 * in declared order and governance (escalation, trust/risk persistence,
 * supervision) is applied by the shared workflow path.
 *
 * Approvals are resolved up front: any requiresApproval action in the workflow
 * must already be approved, otherwise the task blocks with pending requests
 * created — the same gate the reasoner loop applies per action, lifted to the
 * whole workflow because the deterministic run cannot pause to ask mid-phase
 * (spec §Human Oversight). A single shared input bag feeds every action; each
 * action's schema validates the subset it needs.
 */
export const runWorkflowTask = async ({
  task,
  agent,
  workflowName,
  input,
  registry,
  store,
}: {
  task: Task;
  agent: Agent;
  workflowName: string;
  input?: Record<string, unknown>;
  registry: Registry;
  store: StoragePort;
}): Promise<SendResult> => {
  const snapshot = snapshotFromTask(task);

  // The agent must declare the workflow — nothing outside its definition is
  // reachable (spec §Bounded State-Space Model).
  const declares = (agent.workflows ?? []).some((w) => w.name === workflowName);
  if (!declares) {
    await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
    return {
      taskId: task.id,
      status: "failed",
      snapshot,
      reason: `agent "${agent.name}" does not declare workflow "${workflowName}"`,
    };
  }

  const workflowResult = registry.getWorkflow(workflowName);
  if (workflowResult.isErr) {
    await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
    return { taskId: task.id, status: "failed", snapshot, reason: workflowResult.error };
  }
  const workflow = workflowResult.value;

  const actionRegistry = new Map<string, Action>(agent.actions.map((a) => [a.name, a]));

  // ── Approval pre-flight ─────────────────────────────────────────────────
  // Resolve every referenced action's approval status before running. A
  // requiresApproval action that is not yet approved blocks the whole task and
  // auto-requests sign-off (mirrors the reasoner loop's per-action gate).
  const approvalStatuses = new Map<string, ApprovalStatus>();
  const awaitingApproval: string[] = [];
  for (const name of collectWorkflowActionNames(workflow)) {
    const action = actionRegistry.get(name);
    if (action === undefined) continue; // runGateway surfaces the missing-action error.

    const statusResult = await getApprovalStatusForAction({ taskId: task.id, action: name, store });
    let status: ApprovalStatus = statusResult.isOk ? statusResult.value : "none";

    if (action.requiresApproval === true && status === "none") {
      await requestApproval({
        taskId: task.id,
        action: name,
        reason: `action "${name}" requires human approval before workflow "${workflowName}" runs`,
        store,
      });
      status = "pending";
    }

    approvalStatuses.set(name, status);
    if (action.requiresApproval === true && status !== "approved") awaitingApproval.push(name);
  }

  if (awaitingApproval.length > 0) {
    await store.updateTask(task.id, { status: "paused", updatedAt: new Date() });
    return {
      taskId: task.id,
      status: "blocked",
      snapshot,
      reason: `approval-required: workflow "${workflowName}" needs human sign-off for action(s): ${awaitingApproval.join(", ")}`,
    };
  }

  // ── Run the workflow ────────────────────────────────────────────────────
  const result = await runWorkflow({
    workflow,
    actionRegistry,
    state: snapshot,
    getApprovalStatus: (name) => approvalStatuses.get(name) ?? "none",
    inputFor: () => input ?? {},
    store,
  });

  if (result.status === "completed") {
    await store.updateTask(task.id, { status: "completed", updatedAt: new Date() });
    return { taskId: task.id, status: "completed", snapshot: result.snapshot };
  }

  // A blocked workflow already paused the task (escalation or supervision-escalate
  // updates the record before returning); do not overwrite that status.
  if (result.status === "blocked") {
    return { taskId: task.id, status: "blocked", snapshot: result.snapshot, reason: result.reason };
  }

  await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
  return { taskId: task.id, status: "failed", snapshot: result.snapshot, reason: result.failedReason };
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
