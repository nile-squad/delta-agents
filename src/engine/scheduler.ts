/**
 * Interleaving task scheduler — the engine's cooperative multitasking core.
 *
 * A single `delta.send` (or `resume`) may grow into a small supervision tree: a
 * root task that delegates scoped sub-goals to child tasks. The scheduler drives
 * the whole tree to completion within one call, advancing every runnable task by
 * exactly one step per pass (deterministic round-robin). This is the "spawn +
 * poll later" model: a delegation registers a child and returns immediately, and
 * the parent keeps making progress while up to two children run interleaved.
 *
 * Why a step-able loop instead of run-to-completion recursion:
 * The reasoner → gateway cycle is naturally a loop. Factoring out a single
 * `stepTask` lets the scheduler own *when* each task advances, which is what
 * makes interleaving — and the binary supervision tree's two-active-slot bound —
 * expressible without threads. Execution stays single-threaded and fully
 * ordered, so the audit trail and checkpoint writes replay deterministically.
 *
 * Boundedness is structural (spec §Decision: Binary Supervision Tree):
 *   - at most two active children per tree (invariant 15, via requestSlot)
 *   - additional delegations queue FIFO and are promoted on slot release
 *     (invariant 16, via releaseSlot)
 *   - a child's budget is clamped to the parent's remaining headroom
 *     (invariant 18, via enforceSubtaskScope)
 *   - aborting the root cascades to every descendant (invariant 17)
 */

import type { Task, Checkpoint, Cost, TaskTree } from "../shared/types";
import type { JsonRecord } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort, DelegationRequest } from "../ports/reasoner-port";
import type { Registry } from "../authoring/registry";
import type { Agent } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { SendResult } from "./types";
import { snapshotFromTask } from "../state-space/task-state";
import { isOverBudget, addCosts, remainingCost } from "../shared/cost";
import { discoverActions } from "../state-space/discover-actions";
import { runGateway } from "../execution/execution-gateway";
import { applyPostStepGovernance, getApprovalStatusForAction, requestApproval } from "../oversight";
import { enforceSubtaskScope, requestSlot, releaseSlot, abortEntireTree } from "../supervision";
import { initialRiskState, initialTrust } from "../governance";
import { taskId, checkpointId } from "../shared/id";

const snapshotToJson = (snapshot: TaskStateSnapshot): JsonRecord =>
  JSON.parse(JSON.stringify(snapshot)) as JsonRecord;

// ── Step outcome ────────────────────────────────────────────────────────────

/**
 * The result of advancing one task by a single step. The scheduler decides what
 * to do with each: keep stepping, register a child, or settle the task.
 */
type StepOutcome =
  // An action ran (fn returned Ok or Err); keep the task running next pass.
  | { kind: "stepped"; snapshot: TaskStateSnapshot }
  // The reasoner asked to delegate a scoped sub-goal.
  | { kind: "delegate"; snapshot: TaskStateSnapshot; delegation: DelegationRequest }
  // The reasoner signalled done, or no actions remain discoverable.
  | { kind: "natural-done"; snapshot: TaskStateSnapshot }
  // Waiting on a human (approval or escalation) — settle as blocked/paused.
  | { kind: "blocked"; snapshot: TaskStateSnapshot; reason: string }
  // Non-recoverable — settle as failed.
  | { kind: "failed"; snapshot: TaskStateSnapshot; reason: string };

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * A single task's live execution state inside the scheduler. One runner per
 * active task in the tree (root + up to two children).
 */
type Runner = {
  task: Task;
  agent: Agent;
  snapshot: TaskStateSnapshot;
  step: number;
  maxSteps: number;
  settled: boolean;
  result: SendResult | null;
  /** Ids of caller messages already drained into this task's goal (idempotency). */
  consumed: Set<string>;
};

/** Build a runner for a task, seeding the drain-idempotency set from the snapshot. */
export const makeRunner = ({
  task,
  agent,
  snapshot,
  maxSteps,
}: {
  task: Task;
  agent: Agent;
  snapshot: TaskStateSnapshot;
  maxSteps: number;
}): Runner => ({
  task,
  agent,
  snapshot,
  step: 0,
  maxSteps,
  settled: false,
  result: null,
  consumed: new Set(snapshot.consumedMessages ?? []),
});

// ── Single step ──────────────────────────────────────────────────────────────

/**
 * Advance one task by exactly one reasoner → gateway step. Pure of scheduling
 * concerns: it never touches the task tree, never promotes a sibling, and never
 * writes a terminal task status. It returns an outcome and lets the scheduler
 * own all multi-task orchestration and status transitions.
 */
const stepTask = async ({
  task,
  agent,
  snapshot,
  step,
  reasoner,
  registry,
  store,
}: {
  task: Task;
  agent: Agent;
  snapshot: TaskStateSnapshot;
  step: number;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
}): Promise<StepOutcome> => {
  // 1. Discover legal actions for the agent in the current state.
  const agentActionsResult = registry.getActionsForAgent(agent.name);
  if (agentActionsResult.isErr) {
    return { kind: "failed", snapshot, reason: agentActionsResult.error };
  }
  const discovery = discoverActions({ agentActions: agentActionsResult.value, state: snapshot });

  // No discoverable actions — all reachable work is done (or gated). Natural exit.
  if (discovery.available.length === 0) {
    return { kind: "natural-done", snapshot };
  }

  // 2. Ask the reasoner what to do next. Delegation targets are every other
  // deployed agent (an agent does not delegate to itself; the supervision tree
  // and budget scoping bound the rest).
  const reasonResult = await reasoner.reason({
    task: { ...task, risk: snapshot.risk, trust: snapshot.trust, updatedAt: new Date() },
    availableActions: discovery.available.map((a) => a.name),
    availableAgents: registry.listAgents().filter((name) => name !== agent.name),
    agentRole: agent.role,
    rolePrompt: agent.rolePrompt,
  });

  // An Err is a genuine model/API failure or safety refusal — never completion.
  if (reasonResult.isErr) {
    return { kind: "failed", snapshot, reason: `reasoner failed: ${reasonResult.error}` };
  }

  const decision = reasonResult.value;

  if (decision.kind === "done") {
    return { kind: "natural-done", snapshot };
  }

  // Delegation is handled by the scheduler (it owns the tree + slots).
  if (decision.kind === "delegate") {
    return { kind: "delegate", snapshot, delegation: decision.delegation };
  }

  const { actionName, input, reasoningCost } = decision.request;

  // 3. Look up the action definition.
  const actionResult = registry.getAction(actionName);
  if (actionResult.isErr) {
    return { kind: "failed", snapshot, reason: `reasoner requested unknown action "${actionName}"` };
  }
  const action = actionResult.value;

  // 4. Resolve approval status; auto-request and block when required-but-absent.
  const approvalStatusResult = await getApprovalStatusForAction({ taskId: task.id, action: actionName, store });
  const approvalStatus = approvalStatusResult.isOk ? approvalStatusResult.value : "none";

  if (action.requiresApproval === true && approvalStatus === "none") {
    const reqResult = await requestApproval({
      taskId: task.id,
      action: actionName,
      reason: `action "${actionName}" requires human approval before execution`,
      store,
    });
    const approvalIdStr = reqResult.isOk ? reqResult.value.id : "(unavailable)";
    return {
      kind: "blocked",
      snapshot,
      reason: `approval-required: action "${actionName}" needs human sign-off — approval id: ${approvalIdStr}`,
    };
  }

  // 5. Run through the execution gateway.
  const gwResult = await runGateway({ action, rawInput: input, state: snapshot, approvalStatus, store, reasoningCost, stepIndex: step });

  if (gwResult.isErr) {
    const isApprovalBlock = gwResult.error.startsWith("approval-required:");
    return isApprovalBlock
      ? { kind: "blocked", snapshot, reason: gwResult.error }
      : { kind: "failed", snapshot, reason: gwResult.error };
  }

  const { fnResult, updatedSnapshot, surpriseMagnitude } = gwResult.value;
  let next = updatedSnapshot;

  // 6. Post-step governance (escalation + trust/risk persistence), shared with
  // the workflow path. An escalation pauses the task and surfaces as blocked.
  const gov = await applyPostStepGovernance({ taskId: task.id, snapshot: next, surpriseMagnitude, store });
  next = gov.snapshot;
  if (gov.kind === "escalated") {
    return { kind: "blocked", snapshot: next, reason: gov.reason };
  }

  // 7. Checkpoint after a successful action so pause/resume has a recovery point.
  if (fnResult.isOk) {
    const ckpt: Checkpoint = {
      id: checkpointId(),
      taskId: task.id,
      state: snapshotToJson(next),
      createdAt: new Date(),
    };
    await store.saveCheckpoint(ckpt);
  }

  return { kind: "stepped", snapshot: next };
};

// ── Scheduler ────────────────────────────────────────────────────────────────

/** Map a terminal SendResult status to the persisted task status. */
const taskStatusFor = (status: SendResult["status"]): Task["status"] =>
  status === "completed" ? "completed" : status === "blocked" ? "paused" : "failed";

/**
 * Drive a root task and any subtasks it delegates to completion.
 *
 * Each pass advances every still-running task by one step (deterministic
 * round-robin, parent before children). The loop ends when no runner is left
 * running; the root task's terminal result is returned.
 */
export const runScheduler = async ({
  root,
  reasoner,
  registry,
  store,
  maxSteps,
}: {
  root: Runner;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
  maxSteps: number;
}): Promise<SendResult> => {
  const rootId = root.task.rootId;
  const runners: Runner[] = [root];
  let treeInitialized = false;

  const findRunner = (id: string): Runner | undefined => runners.find((r) => r.task.id === id);

  /** Create the supervision tree lazily — only a task that actually delegates needs one. */
  const ensureTree = async (): Promise<TaskTree> => {
    const existing = await store.getTaskTree(rootId);
    if (existing.isOk) {
      treeInitialized = true;
      return existing.value;
    }
    const tree: TaskTree = { rootTaskId: rootId, activeChildren: [], queuedChildren: [], maxConcurrency: 2 };
    await store.saveTaskTree(tree);
    treeInitialized = true;
    return tree;
  };

  /** Load a queued child task and add it as an active runner. */
  const startRunner = async (childTaskId: string): Promise<void> => {
    const taskResult = await store.getTask(childTaskId);
    if (taskResult.isErr) return;
    const childTask = taskResult.value;
    const agentResult = registry.getAgent(childTask.assignedAgent);
    if (agentResult.isErr) return;
    await store.updateTask(childTaskId, { status: "running", updatedAt: new Date() });
    runners.push(
      makeRunner({
        task: { ...childTask, status: "running" },
        agent: agentResult.value,
        snapshot: { ...snapshotFromTask(childTask), status: "running" },
        maxSteps,
      }),
    );
  };

  /** Settle a runner: record its result, persist status, and do tree bookkeeping. */
  const settle = async (runner: Runner, result: SendResult): Promise<void> => {
    runner.settled = true;
    runner.result = result;
    await store.updateTask(runner.task.id, { status: taskStatusFor(result.status), updatedAt: new Date() });

    // Child finished → refund its unused reservation to the parent and free its
    // slot. The parent reserved the child's full budget at delegation; the child
    // only actually consumed `spent`, so return the difference. Net parent spend
    // across delegate + settle is exactly the child's real spend.
    const parentId = runner.task.parentId;
    if (parentId !== undefined && treeInitialized) {
      const parent = findRunner(parentId);
      if (parent !== undefined) {
        const refund = remainingCost(runner.snapshot.budget, runner.snapshot.spent);
        parent.snapshot = { ...parent.snapshot, spent: remainingCost(parent.snapshot.spent, refund) };
        if (parent.result !== null) parent.result = { ...parent.result, snapshot: parent.snapshot };
      }
      const treeResult = await store.getTaskTree(rootId);
      if (treeResult.isOk) {
        const released = releaseSlot(treeResult.value, runner.task.id);
        await store.updateTaskTree(rootId, {
          activeChildren: released.tree.activeChildren,
          queuedChildren: released.tree.queuedChildren,
        });
        if (released.promoted !== undefined) await startRunner(released.promoted);
      }
    }

    // Root failed/blocked while children are live → cascade the abort (invariant 17).
    if (runner.task.id === rootId && result.status !== "completed" && treeInitialized) {
      await abortEntireTree({ rootTaskId: rootId, store });
      for (const r of runners) {
        if (!r.settled && r.task.id !== rootId) {
          r.settled = true;
          r.result = {
            taskId: r.task.id,
            status: "failed",
            snapshot: r.snapshot,
            reason: "aborted: parent tree aborted",
          };
        }
      }
    }
  };

  /** Register a delegated child: scope its budget, create it, take or queue a slot. */
  const handleDelegate = async (parent: Runner, delegation: DelegationRequest): Promise<void> => {
    const agentResult = registry.getAgent(delegation.agentName);
    if (agentResult.isErr) {
      await settle(parent, {
        taskId: parent.task.id,
        status: "failed",
        snapshot: parent.snapshot,
        reason: `delegate failed: agent "${delegation.agentName}" not found`,
      });
      return;
    }

    const requested: Cost = delegation.budget ?? remainingCost(parent.snapshot.budget, parent.snapshot.spent);
    const childBudget = enforceSubtaskScope({
      requestedBudget: requested,
      parentBudget: parent.snapshot.budget,
      parentSpent: parent.snapshot.spent,
    });

    // Reserve the child's budget against the parent up front (debit parent spend
    // by the granted budget). This makes invariant 18 structural: concurrent
    // delegations draw from a shrinking pool, so two children can never each be
    // granted the parent's full remaining. The unused remainder is refunded when
    // the child settles, so the parent ultimately spends only what the child did.
    parent.snapshot = { ...parent.snapshot, spent: addCosts(parent.snapshot.spent, childBudget) };

    const id = taskId();
    const now = new Date();
    const childTask: Task = {
      id,
      rootId,
      parentId: parent.task.id,
      status: "pending",
      goal: delegation.goal,
      assignedAgent: delegation.agentName,
      budget: childBudget,
      risk: initialRiskState(),
      trust: initialTrust(),
      createdAt: now,
      updatedAt: now,
    };
    await store.saveTask(childTask);

    const tree = await ensureTree();
    const slot = requestSlot(tree, id);
    await store.updateTaskTree(rootId, {
      activeChildren: slot.tree.activeChildren,
      queuedChildren: slot.tree.queuedChildren,
    });

    if ("granted" in slot) {
      await store.updateTask(id, { status: "running", updatedAt: new Date() });
      runners.push(
        makeRunner({
          task: { ...childTask, status: "running" },
          agent: agentResult.value,
          // The child carries the parent's budget/spend so the legality guard can
          // block it the moment the parent's budget is exhausted (invariant 18).
          snapshot: {
            ...snapshotFromTask(childTask),
            status: "running",
            parentBudget: parent.snapshot.budget,
            parentSpent: parent.snapshot.spent,
          },
          maxSteps,
        }),
      );
    }
    // Otherwise the child is queued; startRunner promotes it on a slot release.
  };

  /**
   * Drain unconsumed caller messages into the task's goal (H5b). Returns true
   * when at least one was folded in, so the caller keeps the task running to
   * actually handle the new work instead of settling.
   */
  const drainMessages = async (runner: Runner): Promise<boolean> => {
    const msgsResult = await store.getMessages(runner.task.id);
    if (msgsResult.isErr) return false;
    const fresh = msgsResult.value.filter((m) => m.sender === "caller" && !runner.consumed.has(m.id));
    if (fresh.length === 0) return false;

    for (const m of fresh) runner.consumed.add(m.id);
    const appended = fresh.map((m) => String(m.payload)).join("; ");
    runner.task = { ...runner.task, goal: `${runner.task.goal}\n[queued] ${appended}` };
    runner.snapshot = {
      ...runner.snapshot,
      consumedMessages: [...(runner.snapshot.consumedMessages ?? []), ...fresh.map((m) => m.id)],
    };
    // Checkpoint the consumed ids now so the drain is idempotent across a later
    // resume — otherwise, if no action runs after this drain, the consumed set is
    // never persisted and the same messages would be folded in again (D4).
    await store.saveCheckpoint({
      id: checkpointId(),
      taskId: runner.task.id,
      state: snapshotToJson(runner.snapshot),
      createdAt: new Date(),
    });
    return true;
  };

  // ── Main round-robin loop ───────────────────────────────────────────────
  while (true) {
    const active = runners.filter((r) => !r.settled);
    if (active.length === 0) break;

    for (const runner of active) {
      if (runner.settled) continue; // a sibling's abort cascade may have settled it mid-pass

      if (runner.step >= runner.maxSteps) {
        await settle(runner, {
          taskId: runner.task.id,
          status: "failed",
          snapshot: runner.snapshot,
          reason: `task exceeded ${runner.maxSteps}-step limit`,
        });
        continue;
      }

      // Refresh a child's view of the parent budget from the parent's *current*
      // spend, so the legality guard (invariant 18) reflects live interleaving
      // rather than a stale delegation-time copy (D2). When the parent exhausts
      // its budget, the child's actions become illegal on the very next step.
      if (runner.task.parentId !== undefined) {
        const parent = findRunner(runner.task.parentId);
        if (parent !== undefined) {
          runner.snapshot = {
            ...runner.snapshot,
            parentBudget: parent.snapshot.budget,
            parentSpent: parent.snapshot.spent,
          };
        }
      }

      const outcome = await stepTask({
        task: runner.task,
        agent: runner.agent,
        snapshot: runner.snapshot,
        step: runner.step,
        reasoner,
        registry,
        store,
      });
      runner.step++;
      runner.snapshot = outcome.snapshot;

      if (outcome.kind === "stepped") continue;

      if (outcome.kind === "delegate") {
        await handleDelegate(runner, outcome.delegation);
        continue;
      }

      if (outcome.kind === "blocked") {
        await settle(runner, { taskId: runner.task.id, status: "blocked", snapshot: outcome.snapshot, reason: outcome.reason });
        continue;
      }

      if (outcome.kind === "failed") {
        await settle(runner, { taskId: runner.task.id, status: "failed", snapshot: outcome.snapshot, reason: outcome.reason });
        continue;
      }

      // natural-done: drain queued caller messages first; if any arrived, keep
      // running to handle them rather than settling.
      const drained = await drainMessages(runner);
      if (drained) continue;

      // A task that stopped while over budget did not finish cleanly — completion
      // would misreport an exhausted run as success (spec §Cost Friction Detection).
      if (isOverBudget(runner.snapshot.spent, runner.snapshot.budget)) {
        await settle(runner, {
          taskId: runner.task.id,
          status: "failed",
          snapshot: runner.snapshot,
          reason: "task halted with budget exhausted",
        });
        continue;
      }

      // A subtask whose only reason it has nothing left to do is an exhausted
      // parent budget did NOT finish its work — it was starved out of scope
      // (invariant 18). Reporting it completed would hide unfinished work (D2).
      if (
        runner.snapshot.parentBudget !== undefined &&
        runner.snapshot.parentSpent !== undefined &&
        isOverBudget(runner.snapshot.parentSpent, runner.snapshot.parentBudget)
      ) {
        await settle(runner, {
          taskId: runner.task.id,
          status: "failed",
          snapshot: runner.snapshot,
          reason: "subtask halted: parent budget exhausted — cannot exceed parent scope (invariant 18)",
        });
        continue;
      }

      await settle(runner, { taskId: runner.task.id, status: "completed", snapshot: runner.snapshot });
    }
  }

  // ── Aggregate the subtree's outcome into the root result (D1) ─────────────
  // The root's own loop may reach "completed" while a delegated child settled
  // failed or blocked. A parent is not done until its subtree is: a delegated
  // failure must never be reported up as success, and a child blocked on human
  // oversight must surface as blocked. (The free loop has no per-child
  // supervision policy; this propagation is its minimal failure handling.)
  const rootResult: SendResult =
    root.result ?? {
      taskId: root.task.id,
      status: "failed",
      snapshot: root.snapshot,
      reason: "scheduler ended without a root result",
    };
  if (rootResult.status !== "completed") return rootResult;

  const childResults = runners.filter((r) => r.task.id !== rootId).map((r) => r.result);

  const failedChild = childResults.find((r) => r !== null && r.status === "failed");
  if (failedChild != null) {
    await store.updateTask(rootId, { status: "failed", updatedAt: new Date() });
    return {
      ...rootResult,
      status: "failed",
      reason: `delegated subtask "${failedChild.taskId}" failed: ${failedChild.reason ?? "(no reason)"}`,
    };
  }

  const blockedChild = childResults.find((r) => r !== null && r.status === "blocked");
  if (blockedChild != null) {
    await store.updateTask(rootId, { status: "paused", updatedAt: new Date() });
    return {
      ...rootResult,
      status: "blocked",
      reason: `delegated subtask "${blockedChild.taskId}" is blocked awaiting human oversight: ${blockedChild.reason ?? "(no reason)"}`,
    };
  }

  return rootResult;
};
