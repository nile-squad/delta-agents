/**
 * Commit step unit tests (Agent Commit Feature, Phase 7).
 *
 * Exercises `runCommitStep` and `formatCommitContext` directly against an
 * in-memory store + mock reasoner, without going through the full engine.
 * Covers:
 *   - formatCommitContext: bullet formatting, "free-loop" / "no notes" fallbacks
 *   - finish_task ("done") commits with notes, links the latest checkpoint
 *   - non-done decisions are re-prompted, then auto-committed once retries
 *     are exhausted (notes = null)
 *   - reasoner API failure is treated the same as a wrong decision — retried,
 *     then auto-committed (the engine never blocks a task forever on a
 *     flaky provider)
 *   - status is "pendingCommit" for the duration of the step, "completed" after
 */

import { describe, it, expect } from "vitest";
import { Ok, Err } from "slang-ts";
import { runCommitStep, formatCommitContext } from "../../../src/engine/commit-step";
import { createInMemoryStore } from "../../../src/ports/in-memory-store";
import { createMockReasoner } from "../../../src/ports/mock-reasoner";
import { createEngineLogger } from "../../../src/shared/logger";
import { createDiagnostics } from "../../../src/shared/diagnostics";
import { createEvents } from "../../../src/shared/create-events";
import { createRegistry } from "../../../src/authoring/registry";
import { defaultRetryOptions } from "../../../src/infra";
import type { RetryOptions } from "../../../src/infra";
import { snapshotFromTask } from "../../../src/state-space";
import type { Task, Commit } from "../../../src/shared/types";
import type { Agent } from "../../../src/authoring/types";
import type { StoragePort } from "../../../src/ports/storage-port";
import type { ReasonerPort } from "../../../src/ports/reasoner-port";
import type { RuntimeContext } from "../../../src/engine/runtime-context";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const silentLogger = createEngineLogger({ drain: { type: "custom", write: () => {} } });
const noopDiagnostics = createDiagnostics({}, silentLogger);

/** Build the engine-lifetime bundle runCommitStep now takes; only store and the
 * optional retry policy vary across these tests, the rest are inert defaults. */
const makeRuntime = (store: StoragePort, providerRetry: RetryOptions = defaultRetryOptions): RuntimeContext => ({
  store,
  registry: createRegistry(),
  logger: silentLogger,
  diagnostics: noopDiagnostics,
  events: createEvents(),
  providerRetry,
  limits: { maxStepsPerTask: 100, commitContextLimit: 10, maxInvalidDecisionRetries: 3 },
  flags: { guidanceEnabled: true },
});

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "tsk_commit_001",
  rootId: "tsk_commit_001",
  status: "running",
  goal: "run the onboarding workflow",
  assignedAgent: "onboarding-agent",
  budget: { tokens: 5000, durationMs: 60_000 },
  risk: { staticRisk: 0.1, currentRisk: 0.1, predictedRisk: 0.1, confidence: 0.9, escalated: false },
  trust: { score: 0.8, successfulExecutions: 2, failedExecutions: 0, surpriseEvents: 0 },
  createdAt: new Date("2026-06-01T10:00:00.000Z"),
  updatedAt: new Date("2026-06-01T10:00:00.000Z"),
  ...overrides,
});

const agent: Agent = {
  name: "onboarding-agent",
  description: "runs onboarding",
  role: "Onboarding Specialist",
  rolePrompt: "You onboard new customers.",
  actions: [],
};

describe("formatCommitContext", () => {
  it("returns an empty string for no commits", () => {
    expect(formatCommitContext([])).toBe("");
  });

  it("formats a commit with workflow name and notes", () => {
    const commits: Commit[] = [
      {
        id: "cmt_1",
        taskId: "tsk_1",
        agentName: "a",
        workflowName: "onboarding",
        notes: "created the account",
        checkpointId: null,
        createdAt: new Date(Date.now() - 60_000),
      },
    ];
    const out = formatCommitContext(commits);
    expect(out).toContain("[onboarding]");
    expect(out).toContain("created the account");
  });

  it("falls back to \"free-loop\" when workflowName is null", () => {
    const commits: Commit[] = [
      { id: "cmt_1", taskId: "tsk_1", agentName: "a", workflowName: null, notes: "did a thing", checkpointId: null, createdAt: new Date() },
    ];
    expect(formatCommitContext(commits)).toContain("[free-loop]");
  });

  it("falls back to \"no notes\" when notes is null", () => {
    const commits: Commit[] = [
      { id: "cmt_1", taskId: "tsk_1", agentName: "a", workflowName: "wf", notes: null, checkpointId: null, createdAt: new Date() },
    ];
    expect(formatCommitContext(commits)).toContain("no notes");
  });

  it("preserves input order across multiple commits", () => {
    const commits: Commit[] = [
      { id: "cmt_1", taskId: "tsk_1", agentName: "a", workflowName: "wf1", notes: "first", checkpointId: null, createdAt: new Date() },
      { id: "cmt_2", taskId: "tsk_1", agentName: "a", workflowName: "wf2", notes: "second", checkpointId: null, createdAt: new Date() },
    ];
    const lines = formatCommitContext(commits).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });
});

describe("runCommitStep — agent commits via finish_task", () => {
  it("saves a Commit with the reason as notes, links the latest checkpoint, marks the task completed", async () => {
    const store = createInMemoryStore();
    const task = makeTask();
    await store.saveTask(task);
    await store.saveCheckpoint({ id: "ckpt_1", taskId: task.id, state: {}, createdAt: new Date() });

    const reasoner = createMockReasoner({ responses: [{ done: true, reason: "created the account and sent the welcome email" }] });
    const snapshot = snapshotFromTask(task);

    const result = await runCommitStep({
      task, agent, reasoner, workflowName: "onboarding", snapshot,
      runtime: makeRuntime(store),
    });

    expect(result.status).toBe("completed");

    const taskAfter = await store.getTask(task.id);
    expect(taskAfter.isOk && taskAfter.value.status).toBe("completed");

    const commits = await store.getCommitsByAgent(agent.name);
    expect(commits.isOk).toBe(true);
    if (!commits.isOk) return;
    expect(commits.value).toHaveLength(1);
    expect(commits.value[0]?.notes).toBe("created the account and sent the welcome email");
    expect(commits.value[0]?.workflowName).toBe("onboarding");
    expect(commits.value[0]?.checkpointId).toBe("ckpt_1");
    expect(commits.value[0]?.taskId).toBe(task.id);
  });

  it("commits with null notes when finish_task is called without a reason", async () => {
    const store = createInMemoryStore();
    const task = makeTask();
    await store.saveTask(task);

    const reasoner = createMockReasoner({ responses: [{ done: true }] });
    const result = await runCommitStep({
      task, agent, reasoner, workflowName: "onboarding", snapshot: snapshotFromTask(task),
      runtime: makeRuntime(store),
    });

    expect(result.status).toBe("completed");
    const commits = await store.getCommitsByAgent(agent.name);
    expect(commits.isOk && commits.value[0]?.notes).toBe(null);
  });

  it("checkpointId is null when no checkpoint exists yet", async () => {
    const store = createInMemoryStore();
    const task = makeTask();
    await store.saveTask(task);

    const reasoner = createMockReasoner({ responses: [{ done: true, reason: "done" }] });
    await runCommitStep({
      task, agent, reasoner, workflowName: "onboarding", snapshot: snapshotFromTask(task),
      runtime: makeRuntime(store),
    });

    const commits = await store.getCommitsByAgent(agent.name);
    expect(commits.isOk && commits.value[0]?.checkpointId).toBe(null);
  });
});

describe("runCommitStep — agent does not commit", () => {
  it("re-prompts on non-done decisions, then auto-commits with null notes once retries are exhausted", async () => {
    const store = createInMemoryStore();
    const task = makeTask();
    await store.saveTask(task);

    // Scripted to never return "done" — the mock reasoner's "commit" decision
    // is a valid ReasonerDecision kind, just not the one the commit step wants.
    const reasoner = createMockReasoner({
      responses: [{ commit: true, notes: "wrong tool" }, { commit: true, notes: "still wrong" }],
    });

    const result = await runCommitStep({
      task, agent, reasoner, workflowName: "onboarding", snapshot: snapshotFromTask(task),
      maxRetries: 2, runtime: makeRuntime(store),
    });

    expect(result.status).toBe("completed");
    const commits = await store.getCommitsByAgent(agent.name);
    expect(commits.isOk).toBe(true);
    if (!commits.isOk) return;
    // Auto-commit only — the wrong-tool "commit" responses never wrote to the store.
    expect(commits.value).toHaveLength(1);
    expect(commits.value[0]?.notes).toBe(null);
  });

  it("treats reasoner failures the same as a wrong decision — retries then auto-commits", async () => {
    const store = createInMemoryStore();
    const task = makeTask();
    await store.saveTask(task);

    let calls = 0;
    const flaky: ReasonerPort = {
      reason: async () => {
        calls += 1;
        return Err("provider timeout");
      },
    };

    const result = await runCommitStep({
      task, agent, reasoner: flaky, workflowName: "onboarding", snapshot: snapshotFromTask(task),
      maxRetries: 2,
      runtime: makeRuntime(store, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterFactor: 0 }),
    });

    expect(result.status).toBe("completed");
    // One reasoner call per outer attempt (providerRetry maxAttempts: 1).
    expect(calls).toBe(2);
    const commits = await store.getCommitsByAgent(agent.name);
    expect(commits.isOk && commits.value).toHaveLength(1);
    expect(commits.isOk && commits.value[0]?.notes).toBe(null);
  });
});

describe("runCommitStep — status transitions", () => {
  it("sets the task to pendingCommit before the reasoner is consulted", async () => {
    const store = createInMemoryStore();
    const task = makeTask();
    await store.saveTask(task);

    let statusDuringStep: string | undefined;
    const observing: ReasonerPort = {
      reason: async () => {
        const current = await store.getTask(task.id);
        statusDuringStep = current.isOk ? current.value.status : undefined;
        return Ok({ kind: "done", reason: "observed" });
      },
    };

    await runCommitStep({
      task, agent, reasoner: observing, workflowName: "onboarding", snapshot: snapshotFromTask(task),
      runtime: makeRuntime(store),
    });

    expect(statusDuringStep).toBe("pendingCommit");
    const finalTask = await store.getTask(task.id);
    expect(finalTask.isOk && finalTask.value.status).toBe("completed");
  });
});
