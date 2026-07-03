/**
 * Agent Commit Feature integration tests (Phase 7).
 *
 * Exercises the full commit lifecycle through `createDeltaEngine`:
 *   - post-workflow commit step: agent acknowledges via finish_task, notes persisted
 *   - commit context injection: a later task for the same agent sees prior commits
 *     in its ReasonerInput
 *   - hard block: an agent stuck in "pendingCommit" (simulated crash) rejects new
 *     work until resumed
 *   - resume re-enters the commit step from "pendingCommit"
 *   - free-loop system:commit: voluntary mid-task checkpoint, task keeps running
 *   - system:search_commits: model queries past commits mid free-loop
 *   - commitContextLimit: only the most recent N commits are injected
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import type { ReasonerPort, ReasonerInput, ReasonerDecision } from "../../src/ports/reasoner-port";
import type { DeltaEngine } from "../../src/engine/types";
import type { Commit } from "../../src/shared/types";

/** Capture every ReasonerInput the reasoner sees, delegating decisions to a callback. */
const captureReasoner = (
  next: () => ReasonerDecision | Promise<ReasonerDecision>,
): { reasoner: ReasonerPort; inputs: ReasonerInput[] } => {
  const inputs: ReasonerInput[] = [];
  const reasoner: ReasonerPort = {
    reason: async (input) => {
      inputs.push(input);
      return Ok(await next());
    },
  };
  return { reasoner, inputs };
};

const makeWorkflowAgent = (delta: DeltaEngine, ran: string[]) => {
  const step = delta.action({
    name: "onboard-step",
    description: "onboard a customer",
    schema: z.object({}),
    fn: async () => { ran.push("ran"); return Ok("onboarded"); },
  });
  const phase = { name: "only", description: "single phase", actions: ["onboard-step"], checkpoint: true };
  const wf = delta.workflow({ name: "onboarding", description: "onboards a customer", version: "1.0.0", phases: [phase] });
  const agent = delta.agent({
    name: "onboarding-agent",
    description: "runs onboarding",
    role: "Onboarding Specialist",
    rolePrompt: "You onboard customers.",
    actions: [step],
    workflows: [wf],
  });
  delta.deploy(agent);
  return { agent, wf };
};

describe("post-workflow commit step", () => {
  it("agent acknowledges via finish_task; the commit is persisted with the reason as notes", async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });
    makeWorkflowAgent(delta, ran);

    const result = await delta.send({ goal: "onboard customer 42", agentName: "onboarding-agent", workflow: "onboarding" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(ran).toEqual(["ran"]);

    // Empty script -> mock reasoner returns "done" with "mock reasoner: script exhausted".
    const commits = await store.getCommitsByAgent("onboarding-agent");
    expect(commits.isOk).toBe(true);
    if (!commits.isOk) return;
    expect(commits.value).toHaveLength(1);
    expect(commits.value[0]?.workflowName).toBe("onboarding");
    expect(commits.value[0]?.notes).toBe("mock reasoner: script exhausted");
    expect(commits.value[0]?.checkpointId).not.toBe(null);
  });

  it("auto-commits with null notes when the agent never calls finish_task", async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    // "commit" is a valid decision kind but not "done" — the commit step re-prompts,
    // then auto-commits once commitMaxRetries is exhausted.
    const { reasoner } = captureReasoner(() => ({ kind: "commit", notes: "wrong tool for finishing" }));
    const delta = await createDeltaEngine({ store, reasoner, commitMaxRetries: 2 });
    makeWorkflowAgent(delta, ran);

    const result = await delta.send({ goal: "onboard customer 7", agentName: "onboarding-agent", workflow: "onboarding" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");

    const commits = await store.getCommitsByAgent("onboarding-agent");
    expect(commits.isOk).toBe(true);
    if (!commits.isOk) return;
    // Auto-commit only — the wrong-tool "commit" calls did not persist anything themselves.
    expect(commits.value).toHaveLength(1);
    expect(commits.value[0]?.notes).toBe(null);
  });
});

describe("commit context injection", () => {
  it("a later task for the same agent sees the prior commit in its ReasonerInput", async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });
    makeWorkflowAgent(delta, ran);

    const first = await delta.send({ goal: "onboard customer A", agentName: "onboarding-agent", workflow: "onboarding" });
    expect(first.isOk && first.value.status).toBe("completed");

    // Second task, free-loop (no workflow), with a capturing reasoner so we can
    // inspect what the model actually saw.
    const { reasoner, inputs } = captureReasoner(() => ({ kind: "done", reason: "checked in" }));
    const delta2 = await createDeltaEngine({ store, reasoner });
    const noopAction = delta2.action({ name: "noop", description: "d", schema: z.object({}), fn: async () => Ok("ok") });
    delta2.deploy(delta2.agent({ name: "onboarding-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAction] }));

    const second = await delta2.send({ goal: "check on customer A", agentName: "onboarding-agent" });
    expect(second.isOk && second.value.status).toBe("completed");

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.commitContext).toBeDefined();
    expect(inputs[0]?.commitContext).toMatch(/onboarding/);
    expect(inputs[0]?.commitContext).toMatch(/mock reasoner: script exhausted/);
  });

  it("commitContextLimit caps the number of injected commits to the most recent N", async () => {
    const store = createInMemoryStore();
    const now = Date.now();
    const seedCommit = (i: number): Commit => ({
      id: `cmt_seed_${i}`,
      taskId: "tsk_seed",
      agentName: "solo-agent",
      workflowName: "onboarding",
      notes: `commit number ${i}`,
      checkpointId: null,
      createdAt: new Date(now + i * 1000),
    });
    for (let i = 0; i < 5; i++) await store.saveCommit(seedCommit(i));

    const { reasoner, inputs } = captureReasoner(() => ({ kind: "done" }));
    const delta = await createDeltaEngine({ store, reasoner, commitContextLimit: 2 });
    const noopAction = delta.action({ name: "noop", description: "d", schema: z.object({}), fn: async () => Ok("ok") });
    delta.deploy(delta.agent({ name: "solo-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAction] }));

    await delta.send({ goal: "check in", agentName: "solo-agent" });

    expect(inputs[0]?.commitContext).toBeDefined();
    const lines = inputs[0]!.commitContext!.split("\n");
    expect(lines).toHaveLength(2);
    // Newest-first: commit 4 and commit 3.
    expect(lines[0]).toMatch(/commit number 4/);
    expect(lines[1]).toMatch(/commit number 3/);
  });
});

describe("hard block on pendingCommit", () => {
  it("rejects a new task for an agent stuck in pendingCommit, and resume re-enters the commit step", async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });
    const { wf: _wf } = makeWorkflowAgent(delta, ran);

    // Simulate a crash mid-commit-step: run the workflow via a reasoner that never
    // resolves the commit step is impractical here, so instead directly seed a
    // task in "pendingCommit" the way runCommitStep would leave it if the process
    // died before finalizing.
    const crashed = await store.saveTask({
      id: "tsk_crashed",
      rootId: "tsk_crashed",
      status: "pendingCommit",
      goal: "onboard customer stuck mid-commit",
      assignedAgent: "onboarding-agent",
      workflow: "onboarding",
      budget: { tokens: 5000, durationMs: 60_000 },
      risk: { staticRisk: 0.1, currentRisk: 0.1, predictedRisk: 0.1, confidence: 0.9, escalated: false },
      trust: { score: 0.8, successfulExecutions: 1, failedExecutions: 0, surpriseEvents: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(crashed.isOk).toBe(true);

    const blocked = await delta.send({ goal: "onboard another customer", agentName: "onboarding-agent", workflow: "onboarding" });
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk) return;
    expect(blocked.value.status).toBe("pendingCommit");
    expect(blocked.value.reason).toMatch(/resume/);
    expect(blocked.value.taskId).toBe("tsk_crashed");

    // No new task was created for the agent.
    expect(ran).toEqual([]);

    const resumed = await delta.resume("tsk_crashed");
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");

    const commits = await store.getCommitsByAgent("onboarding-agent");
    expect(commits.isOk && commits.value).toHaveLength(1);
  });
});

describe("free-loop system:commit", () => {
  it("records a voluntary commit mid-task without ending it", async () => {
    const store = createInMemoryStore();
    const calls: Array<() => ReasonerDecision> = [
      () => ({ kind: "commit", notes: "halfway through the customer list" }),
      () => ({ kind: "done", reason: "all customers processed" }),
    ];
    let i = 0;
    const { reasoner } = captureReasoner(() => calls[i++]!());
    const delta = await createDeltaEngine({ store, reasoner });
    const noopAction = delta.action({ name: "noop", description: "d", schema: z.object({}), fn: async () => Ok("ok") });
    delta.deploy(delta.agent({ name: "batch-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAction] }));

    const result = await delta.send({ goal: "process the customer list", agentName: "batch-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");

    const commits = await store.getCommitsByAgent("batch-agent");
    expect(commits.isOk).toBe(true);
    if (!commits.isOk) return;
    expect(commits.value).toHaveLength(1);
    expect(commits.value[0]?.workflowName).toBe(null);
    expect(commits.value[0]?.notes).toBe("halfway through the customer list");
  });
});

describe("system:search_commits", () => {
  it("model queries past commits mid free-loop and sees results on its next turn", async () => {
    const store = createInMemoryStore();
    await store.saveCommit({
      id: "cmt_old_1", taskId: "tsk_old", agentName: "search-agent", workflowName: "onboarding",
      notes: "processed refund for customer 9", checkpointId: null, createdAt: new Date(Date.now() - 86_400_000),
    });

    const calls: Array<() => ReasonerDecision> = [
      () => ({ kind: "search-commits", query: { query: "refund" } }),
      () => ({ kind: "done" }),
    ];
    let i = 0;
    const { reasoner, inputs } = captureReasoner(() => calls[i++]!());
    const delta = await createDeltaEngine({ store, reasoner });
    const noopAction = delta.action({ name: "noop", description: "d", schema: z.object({}), fn: async () => Ok("ok") });
    delta.deploy(delta.agent({ name: "search-agent", description: "d", role: "r", rolePrompt: ".", actions: [noopAction] }));

    const result = await delta.send({ goal: "find the refund note", agentName: "search-agent" });
    expect(result.isOk).toBe(true);

    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(inputs[1]?.toolInfoResult).toBeDefined();
    expect(inputs[1]?.toolInfoResult).toMatch(/processed refund for customer 9/);
  });
});
