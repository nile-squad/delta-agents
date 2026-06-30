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
 *   const delta = await createDeltaEngine({ store, reasoner });
 *   const lookup = delta.action({ ... });
 *   const myAgent = delta.agent({ actions: [lookup], ... });
 *   delta.deploy(myAgent);
 *   const result = await delta.send({ goal: "...", agentName: "my-agent" });
 */

import { Ok, Err, option } from "slang-ts";
import { defaultRetryOptions } from "../infra";
import type { DeltaEngineConfig, DeltaEngine } from "./types";
import type { ReasonerPort } from "../ports/reasoner-port";
import { createInMemoryStore } from "../ports/in-memory-store";
import { createMockReasoner } from "../ports/mock-reasoner";
import { createOpenAIReasoner } from "../ports/openai-reasoner";
import { createRegistry } from "../authoring/registry";
import { makeDefineAction } from "../authoring/define-action";
import { makeDefineWorkflow } from "../authoring/define-workflow";
import { makeDefineAgent } from "../authoring/define-agent";
import { makeDefineDataSource } from "../authoring/define-data-source";
import type { Agent } from "../authoring/types";
import type { Message } from "../shared/types";
import { taskId, messageId } from "../shared/id";
import { initialRiskState, initialTrust } from "../governance";
import { snapshotFromTask } from "../state-space/task-state";
import { runSendLoop, runWorkflowTask, pauseTask, resumeTask, inspectTask, resolveApproval } from "./runtime";

const DEFAULT_BUDGET = { tokens: 10_000, durationMs: 300_000 };

export const createDeltaEngine = async ({
  store: configStore,
  endpoint: configEndpoint,
  apiKey: configApiKey,
  options: configOptions,
  models: configModels,
  reasoner: configReasoner,
  maxStepsPerTask = 100,
  reasonerRetry: configReasonerRetry,
}: DeltaEngineConfig = {}): Promise<DeltaEngine> => {
  const store = configStore ?? createInMemoryStore();
  const registry = createRegistry();
  // Resolve the reasoner-retry policy once. Partial config merges over the infra
  // defaults so a caller can tune just the field they care about (e.g. attempts).
  const reasonerRetry = { ...defaultRetryOptions, ...configReasonerRetry };

  // ── Model config validation ──────────────────────────────────────────────
  // Validate models at construction time so mistakes surface immediately, not
  // buried inside a future send(). These are programming errors, not runtime
  // errors, so we throw rather than return Err.
  if (configModels !== undefined && configModels.length > 0) {
    const names = configModels.map((m) => m.name);
    const uniqueNames = new Set(names);
    if (uniqueNames.size !== names.length) {
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      throw new Error(`createDeltaEngine: duplicate model names: ${[...new Set(dupes)].join(", ")}`);
    }
    const defaults = configModels.filter((m) => m.default === true);
    if (defaults.length === 0) {
      throw new Error(
        `createDeltaEngine: no default model — exactly one model must have default: true`,
      );
    }
    if (defaults.length > 1) {
      throw new Error(
        `createDeltaEngine: multiple default models (${defaults.map((m) => m.name).join(", ")}) — exactly one must have default: true`,
      );
    }
  }

  // Pre-build the set of model names so define-agent can validate agent.model
  // at authoring time (caught before any send, not at run-time mid-task).
  const modelNames: Set<string> =
    configModels !== undefined ? new Set(configModels.map((m) => m.name)) : new Set();

  // Reasoner instances are created once per agent and cached — the OpenAI client
  // holds a connection pool so recreating it per send is wasteful.
  const reasonerCache = new Map<string, ReasonerPort>();

  const resolveReasoner = (agentDef: Agent): ReasonerPort => {
    // Test/escape-hatch override: one shared adapter for all agents.
    if (configReasoner !== undefined) return configReasoner;

    // No models defined → fall back to mock (covers tests that omit models).
    if (configModels === undefined || configModels.length === 0) return createMockReasoner();

    const cached = option(reasonerCache.get(agentDef.name));
    if (cached.isSome) return cached.value;

    const modelOpt = option(
      agentDef.model !== undefined
        ? configModels.find((m) => m.name === agentDef.model)
        : configModels.find((m) => m.default === true),
    );

    // Should never happen: both cases were validated at delta.agent() and
    // construction time respectively. Guard defensively.
    if (modelOpt.isNone) {
      throw new Error(
        `createDeltaEngine: could not resolve model for agent "${agentDef.name}"`,
      );
    }

    const resolved = createOpenAIReasoner({
      apiKey: modelOpt.value.apiKey ?? configApiKey,
      baseURL: modelOpt.value.endpoint ?? configEndpoint,
      model: modelOpt.value.model,
      temperature: modelOpt.value.options?.temperature ?? configOptions?.temperature,
      topP: modelOpt.value.options?.topP ?? configOptions?.topP,
      maxTokens: modelOpt.value.options?.maxTokens ?? configOptions?.maxTokens,
    });
    reasonerCache.set(agentDef.name, resolved);
    return resolved;
  };

  // Await the store's readiness gate before the engine serves any request. An
  // adapter that needs async warm-up (open a connection, run migrations) signals
  // it here; construction fails loudly if the data layer cannot come up, rather
  // than deferring the error to the first send. Adapters with no async setup
  // (the in-memory store) omit `ready` and this is a no-op.
  if (store.ready !== undefined) {
    const readiness = await store.ready();
    if (readiness.isErr) {
      throw new Error(`createDeltaEngine: storage adapter is not ready: ${readiness.error}`);
    }
  }

  // ── Authoring methods ────────────────────────────────────────────────────
  const action = makeDefineAction({ registry });
  const workflow = makeDefineWorkflow({ registry });
  const dataSource = makeDefineDataSource({ registry });
  const agent = makeDefineAgent({ registry, modelNames });

  // ── Runtime methods ──────────────────────────────────────────────────────

  const deploy = (_agent: ReturnType<typeof agent>): void => {
    // deploy() is the DX signal that authoring is complete and execution can begin.
    // It marks the agent as deployed in the registry (L1: send rejects a defined-but-
    // undeployed agent with a clear error message). Without this gate an agent that is
    // merely defined — but whose authoring is incomplete — could silently accept tasks.
    const result = registry.deployAgent(_agent.name);
    if (result.isErr) {
      throw new Error(`delta.deploy: ${result.error}`);
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
    if (latestResult.isOk) {
      const taskOpt = option(latestResult.value);
      if (taskOpt.isSome) {
        const existing = taskOpt.value;
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
    }

    // L1: gate on deploy() — an agent that is defined (registered) but not yet
    // deployed must not accept tasks. Authoring and execution are intentionally
    // separated so partial setups (missing actions, unapproved configs) cannot
    // silently run. Return a clear, actionable error so the developer knows exactly
    // what to call (prohibition 9: never fail silently on a misuse boundary).
    const agentResult = registry.getAgent(agentName);
    if (agentResult.isErr) {
      return Err(`send failed: agent "${agentName}" not found — ${agentResult.error}`);
    }
    if (!registry.isDeployed(agentName)) {
      return Err(
        `send failed: agent "${agentName}" is defined but not deployed — call delta.deploy(agent) first`,
      );
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
      : await runSendLoop({ task, agent: agentDef, reasoner: resolveReasoner(agentDef), registry, store, maxSteps: maxStepsPerTask, reasonerRetry });

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
    // Same deploy gate as send: an undeployed agent must not execute actions
    // through any entry point. Keeps the "deployed before execution" invariant
    // uniform across send and resume (security review J4, low finding).
    if (!registry.isDeployed(task.assignedAgent)) {
      return Err(
        `resume failed: agent "${task.assignedAgent}" is defined but not deployed — call delta.deploy(agent) first`,
      );
    }

    return resumeTask({
      taskId: taskId_,
      agent: agentResult.value,
      reasoner: resolveReasoner(agentResult.value),
      registry,
      store,
      maxSteps: maxStepsPerTask,
      reasonerRetry,
    });
  };

  const inspect: DeltaEngine["inspect"] = async (taskId_) => {
    return inspectTask({ taskId: taskId_, store });
  };

  const lastTask: DeltaEngine["lastTask"] = async (agentName) => {
    return store.getLatestTaskByAgent(agentName);
  };

  return { action, workflow, dataSource, agent, deploy, send, approve, pause, resume, inspect, lastTask };
};
