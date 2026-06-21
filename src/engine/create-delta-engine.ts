/**
 * createDeltaEngine — the single factory that assembles the Delta facade.
 *
 * Returns one object whose methods are the entire developer surface — both
 * authoring (define capabilities) and runtime (drive execution). Internally
 * each capability lives in its own module; this factory is the only place
 * they meet. Module implementations stay decoupled; the facade is the only
 * coupling point (spec §Delta DX, context.md §DX Pattern).
 *
 * Configuration:
 *   store    — StoragePort adapter (default: isolated in-memory)
 *   reasoner — ReasonerPort adapter (default: mock; OpenAI in Phase 10)
 *   maxStepsPerTask — step limit per send/resume loop (default: 100)
 *
 * Usage:
 *   const delta = createDeltaEngine({ store, reasoner });
 *   const lookup = delta.action({ ... });
 *   const myAgent = delta.agent({ actions: [lookup], ... });
 *   delta.deploy(myAgent);
 *   const result = await delta.send({ goal: "...", agentName: "my-agent" });
 */

import { Ok, Err } from "slang-ts";
import type { DeltaEngineConfig, DeltaEngine } from "./types";
import { createInMemoryStore } from "../ports/in-memory-store";
import { createMockReasoner } from "../ports/mock-reasoner";
import { createRegistry } from "../authoring/registry";
import { makeDefineAction } from "../authoring/define-action";
import { makeDefineWorkflow } from "../authoring/define-workflow";
import { makeDefinePhase } from "../authoring/define-phase";
import { makeDefineAgent } from "../authoring/define-agent";
import type { Message } from "../shared/types";
import { taskId, messageId } from "../shared/id";
import { initialRiskState, initialTrust } from "../governance";
import { snapshotFromTask } from "../state-space/task-state";
import { runSendLoop, runWorkflowTask, pauseTask, resumeTask, inspectTask, resolveApproval } from "./runtime";

const DEFAULT_BUDGET = { tokens: 10_000, durationMs: 300_000 };

export const createDeltaEngine = ({
  store: configStore,
  reasoner: configReasoner,
  maxStepsPerTask = 100,
}: DeltaEngineConfig = {}): DeltaEngine => {
  const store = configStore ?? createInMemoryStore();
  const reasoner = configReasoner ?? createMockReasoner();
  const registry = createRegistry();

  // ── Authoring methods ────────────────────────────────────────────────────
  const action = makeDefineAction({ registry });
  const workflow = makeDefineWorkflow({ registry });
  const phase = makeDefinePhase({ registry });
  const agent = makeDefineAgent({ registry });

  // ── Runtime methods ──────────────────────────────────────────────────────

  const deploy = (_agent: ReturnType<typeof agent>): void => {
    // The agent is already registered by delta.agent(). deploy() is the
    // DX signal that authoring is complete and execution can begin.
    // Validation: confirm the agent is in the registry (throws on misuse).
    const check = registry.getAgent(_agent.name);
    if (check.isErr) {
      throw new Error(
        `delta.deploy: agent "${_agent.name}" is not registered — call delta.agent() first`,
      );
    }
  };

  const send: DeltaEngine["send"] = async ({ goal, agentName, budget = DEFAULT_BUDGET, workflow: workflowName, input, actionInputs }) => {
    // ── Invariant 26: one MAJOR task per agent ─────────────────────────────
    // Per spec §No New Task When Work Is Pending, an agent that already has an
    // active/pending *major* (top-level) task does not get a second one — the
    // inbound goal is queued as a message attributable to the existing task
    // (invariant 9) and the engine returns that task, not a rejection.
    //
    // The concurrency model is per pool (owner ruling): an agent owns at most
    // one major task at a time, separately at most two active subtasks
    // (delegations, bounded by the binary supervision tree), and an unlimited
    // queue. A running *subtask* (parentId set) therefore does NOT count as the
    // agent's major task — it must not block a new major send or have a major
    // goal mis-attached to it.
    const latestResult = await store.getLatestTaskByAgent(agentName);
    if (latestResult.isOk && latestResult.value !== null) {
      const existing = latestResult.value;
      const isMajor = existing.parentId === undefined;
      if (isMajor && (existing.status === "running" || existing.status === "pending")) {
        const message: Message = {
          id: messageId(),
          taskId: existing.id,
          sender: "caller",
          receiver: agentName,
          payload: goal,
          createdAt: new Date(),
        };
        const queued = await store.saveMessage(message);
        if (queued.isErr) {
          return Err(
            `send failed: agent "${agentName}" is busy and the message could not be queued: ${queued.error}`,
          );
        }
        return Ok({
          taskId: existing.id,
          status: "queued",
          snapshot: snapshotFromTask(existing),
          reason:
            `agent "${agentName}" is busy on task "${existing.id}" — ` +
            `message queued, no new task created (invariant 26)`,
        });
      }
    }

    const agentResult = registry.getAgent(agentName);
    if (agentResult.isErr) {
      return Err(`send failed: agent "${agentName}" not deployed — ${agentResult.error}`);
    }
    const agentDef = agentResult.value;

    // ── Create and persist the task ─────────────────────────────────────
    const id = taskId();
    const now = new Date();
    const task = {
      id,
      rootId: id,
      status: "running" as const,
      goal,
      assignedAgent: agentName,
      workflow: workflowName,
      budget,
      risk: initialRiskState(),
      trust: initialTrust(),
      createdAt: now,
      updatedAt: now,
    };

    const saveResult = await store.saveTask(task);
    if (saveResult.isErr) {
      return Err(`send failed: could not persist task: ${saveResult.error}`);
    }

    // C-a coexistence: a task with an assigned workflow runs deterministically
    // through the workflow engine (reasoner-less); a workflow-less task uses the
    // free reasoner loop.
    const result = workflowName !== undefined
      ? await runWorkflowTask({ task, agent: agentDef, workflowName, input, actionInputs, registry, store })
      : await runSendLoop({ task, agent: agentDef, reasoner, registry, store, maxSteps: maxStepsPerTask });

    return Ok(result);
  };

  const approve: DeltaEngine["approve"] = async (approvalId) => {
    return resolveApproval({ approvalId, decision: "approved", store });
  };

  const pause: DeltaEngine["pause"] = async (taskId_) => {
    return pauseTask({ taskId: taskId_, store });
  };

  const resume: DeltaEngine["resume"] = async (taskId_) => {
    const taskResult = await store.getTask(taskId_);
    if (taskResult.isErr) return Err(`resume failed: ${taskResult.error}`);
    const task = taskResult.value;

    const agentResult = registry.getAgent(task.assignedAgent);
    if (agentResult.isErr) {
      return Err(`resume failed: agent "${task.assignedAgent}" not in registry — ${agentResult.error}`);
    }

    return resumeTask({
      taskId: taskId_,
      agent: agentResult.value,
      reasoner,
      registry,
      store,
      maxSteps: maxStepsPerTask,
    });
  };

  const inspect: DeltaEngine["inspect"] = async (taskId_) => {
    return inspectTask({ taskId: taskId_, store });
  };

  const lastTask: DeltaEngine["lastTask"] = async (agentName) => {
    return store.getLatestTaskByAgent(agentName);
  };

  return { action, workflow, phase, agent, deploy, send, approve, pause, resume, inspect, lastTask };
};
