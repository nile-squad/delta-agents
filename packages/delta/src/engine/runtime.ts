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

import { option } from "slang-ts";
import type { Task, Attachment } from "../shared/types";
import type { ReasonerPort } from "../ports/reasoner-port";
import type { Agent, Action, Workflow } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { ApprovalStatus } from "../execution/types";
import type { SendResult } from "./types";
import { snapshotFromTask, snapshotToJson } from "../state-space/task-state";
import { runWorkflow } from "../workflow";
import { makeContextCommunicate } from "../comms";
import { makeContextRemember, makeContextRecall } from "../memory";
import { getApprovalStatusForAction, requestApproval, recordAutoApproval, approvalRequired, describeRejection, raiseEscalation } from "../oversight";
import { resolveApproval } from "../oversight";
import { projectHorizon } from "../governance";
import type { HorizonStep } from "../governance";
import { isOverBudget } from "../shared/cost";
import { checkpointId } from "../shared/id";
import { makeRunner, runScheduler } from "./scheduler";
import type { RuntimeContext } from "./runtime-context";
import { runCommitStep } from "./commit-step";

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
  startingSnapshot,
  attachments,
  runtime,
}: {
  task: Task;
  agent: Agent;
  reasoner: ReasonerPort;
  startingSnapshot?: TaskStateSnapshot;
  /** Attachments supplied at send() time; seeds the initial snapshot. Absent on resume (already persisted in the checkpointed snapshot). */
  attachments?: Attachment[];
  /** Engine-lifetime dependency bundle (store, registry, retry policy, limits, flags, …). */
  runtime: RuntimeContext;
}): Promise<SendResult> => {
  const { events } = runtime;
  const maxSteps = runtime.limits.maxStepsPerTask ?? MAX_STEPS_DEFAULT;
  const root = makeRunner({
    task,
    agent,
    snapshot: startingSnapshot ?? { ...snapshotFromTask(task), ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) },
    maxSteps,
  });
  const schedulerResult = await runScheduler({ root, reasoner, runtime });
  if (schedulerResult.status === "completed") {
    events.emit("task-completed", { taskId: task.id, agentName: agent.name, goal: task.goal });
  } else if (schedulerResult.status === "blocked") {
    events.emit("task-blocked", { taskId: task.id, agentName: agent.name, reason: schedulerResult.reason ?? "unknown" });
  } else if (schedulerResult.status === "failed") {
    events.emit("task-failed", { taskId: task.id, agentName: agent.name, reason: schedulerResult.reason ?? "unknown" });
  }
  return schedulerResult;
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
  startingSnapshot,
  reasoner,
  commitMaxRetries,
  attachments,
  runtime,
}: {
  task: Task;
  agent: Agent;
  workflowName: string;
  input?: Record<string, unknown>;
  /** Per-action input overrides; when present for an action, replaces the shared `input` bag. */
  actionInputs?: Record<string, Record<string, string | number | boolean | null>>;
  /** Resume state reconstructed from a checkpoint. When present, completed phases
   *  are skipped and the persisted send-time input is reused (resumeTask path). */
  startingSnapshot?: TaskStateSnapshot;
  /** Reasoner adapter used by the post-workflow commit step to ask the agent to
   * acknowledge completion. Threaded from the engine factory so the same model
   * that ran the workflow gets the commit call. */
  reasoner: ReasonerPort;
  /** Max reasoner attempts in the commit step before auto-committing with no notes. */
  commitMaxRetries?: number;
  /** Attachments supplied at send() time; seeds the initial snapshot. Absent on resume (already persisted in the checkpointed snapshot). */
  attachments?: Attachment[];
  /** Engine-lifetime dependency bundle (store, registry, retry policy, diagnostics, flags, …). */
  runtime: RuntimeContext;
}): Promise<SendResult> => {
  const { registry, store, diagnostics, events } = runtime;
  const { guidanceEnabled } = runtime.flags;
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
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : (base.attachments !== undefined ? { attachments: base.attachments } : {})),
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
  const rejectedDescriptions: string[] = [];
  for (const name of collectWorkflowActionNames(workflow)) {
    const actionOpt = option(actionRegistry.get(name));
    if (actionOpt.isNone) continue; // runGateway surfaces the missing-action error.
    const action = actionOpt.value;

    const statusResult = await getApprovalStatusForAction({ taskId: task.id, action: name, store });
    let status: ApprovalStatus = statusResult.isOk ? statusResult.value : "none";

    // A rejected action fails the whole workflow below — the deterministic path
    // has no way to route around it, and blocking would misleadingly imply the
    // approval could still be granted (prohibition 11: a rejection is final).
    if (approvalRequired(action.requiresApproval) && status === "rejected") {
      rejectedDescriptions.push(await describeRejection({ taskId: task.id, action: name, store }));
      approvalStatuses.set(name, status);
      continue;
    }

    // `{ untilTrust }` waiver, same as the reasoner loop's per-action gate: with
    // no request on record and the task's trust at/above the declared threshold,
    // the gate is auto-approved (audited).
    if (approvalRequired(action.requiresApproval) && status === "none") {
      const untilTrustOpt = option(
        typeof action.requiresApproval === "object" ? action.requiresApproval.untilTrust : undefined,
      );
      if (untilTrustOpt.isSome && snapshot.trust.score >= untilTrustOpt.value) {
        const autoResult = await recordAutoApproval({
          taskId: task.id,
          action: name,
          reason: `auto-approved: trust ${snapshot.trust.score.toFixed(2)} >= ${untilTrustOpt.value} (declared waiver)`,
          store,
        });
        if (autoResult.isOk) {
          events.emit("approval-requested", { taskId: task.id, agentName: agent.name, action: name, approvalId: autoResult.value.id, reason: autoResult.value.reason });
        }
        status = "approved";
      } else {
        const reqResult = await requestApproval({
          taskId: task.id,
          action: name,
          reason: `action "${name}" requires human approval before workflow "${workflowName}" runs`,
          store,
        });
        if (reqResult.isOk) {
          events.emit("approval-requested", { taskId: task.id, agentName: agent.name, action: name, approvalId: reqResult.value.id, reason: reqResult.value.reason });
        }
        status = "pending";
      }
    }

    approvalStatuses.set(name, status);
    if (approvalRequired(action.requiresApproval) && status !== "approved") awaitingApproval.push(name);
  }

  if (rejectedDescriptions.length > 0) {
    await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
    return {
      taskId: task.id,
      status: "failed",
      snapshot,
      reason: `workflow "${workflowName}" cannot run: ${rejectedDescriptions.join("; ")}`,
    };
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
    events.emit("escalation-raised", {
      taskId: task.id,
      agentName: agent.name,
      trigger: "budget-violation",
      reason: `projected workflow cost (${horizon.totalProjectedCost.tokens} tokens / ${horizon.totalProjectedCost.durationMs}ms over ${horizon.stepsTaken} step(s)) exceeds budget before execution (MPC)`,
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
    recall: makeContextRecall({ store, taskId: task.id, agentName: agent.name }),
    agentSkills: agent.skills,
    diagnostics,
    guidanceEnabled,
    goal: task.goal,
    ...(snapshot.attachments !== undefined && snapshot.attachments.length > 0 ? { attachments: snapshot.attachments } : {}),
    budget: { spent: snapshot.spent, limit: snapshot.budget },
  });

  if (result.status === "completed") {
    // Run the post-workflow commit step — the agent must acknowledge
    // completion with optional notes. This is mandatory for workflows.
    const commitResult = await runCommitStep({
      task,
      agent,
      reasoner,
      workflowName,
      snapshot: result.snapshot,
      maxRetries: commitMaxRetries,
      runtime,
    });
    if (commitResult.status === "completed") {
      events.emit("task-completed", { taskId: task.id, agentName: agent.name, goal: task.goal });
    } else if (commitResult.status === "blocked") {
      events.emit("task-blocked", { taskId: task.id, agentName: agent.name, reason: commitResult.reason ?? "unknown" });
    } else {
      events.emit("task-failed", { taskId: task.id, agentName: agent.name, reason: commitResult.reason ?? "unknown" });
    }
    return commitResult;
  }

  // A blocked workflow already paused the task (escalation or supervision-escalate
  // updates the record before returning); do not overwrite that status.
  if (result.status === "blocked") {
    events.emit("task-blocked", { taskId: task.id, agentName: agent.name, reason: result.reason ?? "unknown" });
    return { taskId: task.id, status: "blocked", snapshot: result.snapshot, reason: result.reason };
  }

  await store.updateTask(task.id, { status: "failed", updatedAt: new Date() });
  events.emit("task-failed", { taskId: task.id, agentName: agent.name, reason: result.failedReason ?? "unknown" });
  return { taskId: task.id, status: "failed", snapshot: result.snapshot, reason: result.failedReason };
};


// ── Lifecycle operations ──────────────────────────────────────────────────────
// pauseTask / resumeTask / inspectTask live in ./runtime-lifecycle (resumeTask
// calls back into runSendLoop / runWorkflowTask above). Re-exported here so
// existing import paths (`from "./runtime"`) keep working.
export { pauseTask, resumeTask, inspectTask } from "./runtime-lifecycle";

// Re-export resolveApproval for the approve() facade method.
export { resolveApproval };
