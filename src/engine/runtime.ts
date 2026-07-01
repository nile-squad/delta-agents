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

import { Ok, Err, option } from "slang-ts";
import type { Result } from "slang-ts";
import type { Task, Checkpoint, ApprovalRequest } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort } from "../ports/reasoner-port";
import type { Registry } from "../authoring/registry";
import type { Agent, Action, Workflow } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { ApprovalStatus } from "../execution/types";
import type { RetryOptions } from "../infra";
import type { SendResult, InspectResult } from "./types";
import { snapshotFromTask, snapshotFromJson, snapshotToJson } from "../state-space/task-state";
import { runWorkflow } from "../workflow";
import { makeContextCommunicate } from "../comms";
import { makeContextRemember } from "../memory";
import { getApprovalStatusForAction, requestApproval, raiseEscalation } from "../oversight";
import { resolveApproval } from "../oversight";
import { projectHorizon } from "../governance";
import type { HorizonStep } from "../governance";
import { isOverBudget } from "../shared/cost";
import { checkpointId } from "../shared/id";
import { makeRunner, runScheduler } from "./scheduler";
import type { Logger } from "../shared/logger-types";
import type { Diagnostics } from "../shared/diagnostics";

const MAX_STEPS_DEFAULT = 100;

// ── Core send loop ────────────────────────────────────────────────────────────

/**
 * Drive a task — and any subtasks it delegates — to a terminal state.
 *
 * The per-step reasoner → gateway cycle and the multi-task orchestration both
 * live in the scheduler (./scheduler.ts). This wrapper just builds the root
 * runner and hands it over. A `kind: "delegate"` decision spawns a bounded child
 * task that runs interleaved with the parent (at most two active per tree); a
 * checkpoint is written after every successful action for pause/resume.
 */
export const runSendLoop = async ({
  task,
  agent,
  reasoner,
  registry,
  store,
  maxSteps = MAX_STEPS_DEFAULT,
  startingSnapshot,
  providerRetry,
  timezone,
  logger,
  diagnostics,
}: {
  task: Task;
  agent: Agent;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
  maxSteps?: number;
  startingSnapshot?: TaskStateSnapshot;
  providerRetry?: RetryOptions;
  /** Timezone for humanized time in reasoner user messages; falls back to system tz in the scheduler. */
  timezone?: string;
  /** Per-engine logger threaded from the engine factory. */
  logger: Logger;
  /** Per-engine diagnostics handle. Threaded into the scheduler so opt-in
   * modules can emit structured events; a no-op when diagnostics is disabled. */
  diagnostics: Diagnostics;
}): Promise<SendResult> => {
  const root = makeRunner({
    task,
    agent,
    snapshot: startingSnapshot ?? snapshotFromTask(task),
    maxSteps,
  });
  return runScheduler({ root, reasoner, registry, store, maxSteps, providerRetry, timezone, logger, diagnostics });
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

/** Build the MPC horizon for a workflow: its actions in declared order, with the
 * declared estimatedCost per step. An action with no declared cost is an epistemic
 * boundary — projection cannot see past an unknown cost (prohibition 14). */
const buildHorizonSteps = (workflow: Workflow, actionRegistry: Map<string, Action>): HorizonStep[] => {
  const steps: HorizonStep[] = [];
  for (const phase of workflow.phases) {
    for (const ref of phase.actions) {
      const name = typeof ref === "string" ? ref : ref.action;
      const action = actionRegistry.get(name);
      steps.push({
        actionName: name,
        estimatedCost: action?.estimatedCost ?? { tokens: 0, durationMs: 0 },
        isEpistemicBoundary: action?.estimatedCost === undefined,
      });
    }
  }
  return steps;
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
  actionInputs,
  registry,
  store,
  startingSnapshot,
  diagnostics,
}: {
  task: Task;
  agent: Agent;
  workflowName: string;
  input?: Record<string, unknown>;
  /** Per-action input overrides; when present for an action, replaces the shared `input` bag. */
  actionInputs?: Record<string, Record<string, string | number | boolean | null>>;
  registry: Registry;
  store: StoragePort;
  /** Resume state reconstructed from a checkpoint. When present, completed phases
   *  are skipped and the persisted send-time input is reused (resumeTask path). */
  startingSnapshot?: TaskStateSnapshot;
  /** Per-engine diagnostics handle. Threaded into the workflow + phase + gateway
   * paths so opt-in modules can emit structured events. */
  diagnostics: Diagnostics;
}): Promise<SendResult> => {
  // On a fresh send, start from the task record. On resume, start from the
  // checkpoint snapshot so completedPhases and the original input survive.
  const base = startingSnapshot ?? snapshotFromTask(task);

  // The effective inputs are the call's inputs on a fresh send, or the inputs
  // persisted on the snapshot when resuming (the call has none on resume).
  const effectiveInput = input ?? base.workflowInput;
  const effectiveActionInputs = actionInputs ?? base.workflowActionInputs;

  const snapshot: TaskStateSnapshot = {
    ...base,
    completedPhases: base.completedPhases ?? [],
    workflowInput: effectiveInput,
    workflowActionInputs: effectiveActionInputs,
  };

  // Capture the send-time input in a checkpoint up front (fresh send only). A
  // workflow can block on the approval pre-flight BEFORE any phase runs and thus
  // before any phase checkpoint exists; without this, a resume after that block
  // would have no record of the input and could not re-run the workflow faithfully.
  if (startingSnapshot === undefined) {
    await store.saveCheckpoint({
      id: checkpointId(),
      taskId: task.id,
      state: snapshotToJson(snapshot),
      createdAt: new Date(),
    });
  }

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
    const actionOpt = option(actionRegistry.get(name));
    if (actionOpt.isNone) continue; // runGateway surfaces the missing-action error.
    const action = actionOpt.value;

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

  // ── Predictive (MPC) budget check ───────────────────────────────────────
  // Project the declared cost of the upcoming actions (stopping at the first
  // epistemic boundary — an action with no declared cost) and refuse to start a
  // workflow whose *known* projected cost already exceeds the budget. Preventing
  // failure is cheaper than recovering from it (spec §Model Predictive Control:
  // evaluate the finite future trajectory before allowing execution).
  const horizon = projectHorizon({ steps: buildHorizonSteps(workflow, actionRegistry) });
  if (isOverBudget(horizon.totalProjectedCost, task.budget)) {
    await raiseEscalation({
      taskId: task.id,
      trigger: "budget-violation",
      reason: `projected workflow cost (${horizon.totalProjectedCost.tokens} tokens / ${horizon.totalProjectedCost.durationMs}ms over ${horizon.stepsTaken} step(s)) exceeds budget before execution (MPC)`,
      store,
    });
    await store.updateTask(task.id, { status: "paused", updatedAt: new Date() });
    return {
      taskId: task.id,
      status: "blocked",
      snapshot,
      reason: `escalated: workflow "${workflowName}" is projected to exceed its budget before execution (MPC)`,
    };
  }

  // ── Run the workflow ────────────────────────────────────────────────────
  const result = await runWorkflow({
    workflow,
    actionRegistry,
    state: snapshot,
    getApprovalStatus: (name) => approvalStatuses.get(name) ?? "none",
    inputFor: (name) => effectiveActionInputs?.[name] ?? effectiveInput ?? {},
    store,
    communicate: makeContextCommunicate({ agent, taskId: task.id, agentName: agent.name, store }),
    remember: makeContextRemember({ store, taskId: task.id, agentName: agent.name }),
    agentSkills: agent.skills,
    diagnostics,
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
}): Promise<Result<SendResult, string>> => {
  const taskResult = await store.getTask(taskId);
  if (taskResult.isErr) return Err(`cannot resume: task "${taskId}" not found`);
  const task = taskResult.value;

  if (task.status !== "paused" && task.status !== "pending") {
    return Err(`cannot resume task "${taskId}" — current status is "${task.status}" (expected "paused" or "pending")`);
  }

  const ckptResult = await store.getLatestCheckpoint(taskId);
  if (ckptResult.isErr) return Err(`cannot resume: checkpoint read failed: ${ckptResult.error}`);

  const startingSnapshot: TaskStateSnapshot =
    ckptResult.value !== null
      ? { ...snapshotFromJson(ckptResult.value.state), status: "running" as const }
      : { ...snapshotFromTask(task), status: "running" as const };

  const updateResult = await store.updateTask(taskId, { status: "running", updatedAt: new Date() });
  if (updateResult.isErr) return Err(`failed to mark task as running: ${updateResult.error}`);

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
      diagnostics,
    });
    return Ok(result);
  }

  const result = await runSendLoop({ task, agent, reasoner, registry, store, maxSteps, startingSnapshot, providerRetry, timezone, logger, diagnostics });
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
