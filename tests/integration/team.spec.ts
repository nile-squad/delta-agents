/**
 * Team tests: teams scope who an agent can collaborate with, and add a mention
 * primitive for lightweight teammate interaction.
 *
 *   - getTeammates: agents sharing a non-empty team are teammates; an agent with
 *     no team has every other agent as a peer (teams are opt-in scoping).
 *   - Delegation is scoped: an agent may delegate only to a teammate; delegating
 *     across teams is rejected at the engine, not just hidden from the reasoner.
 *   - Mention: an agent leaves a teammate a TaskID-attributable note (no child
 *     task); mentioning a non-teammate is rejected.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createRegistry } from "../../src/authoring";
import { createInMemoryStore } from "../../src/ports";
import type { ReasonerPort } from "../../src/ports/reasoner-port";

const anAction = (delta: Awaited<ReturnType<typeof createDeltaEngine>>, name: string) =>
  delta.action({ name, description: "work", schema: z.object({}), fn: async () => Ok("ok") });

describe("registry.getTeammates", () => {
  it("scopes by team, and treats a team-less agent as peer of everyone", () => {
    const reg = createRegistry();
    const base = { description: "d", role: "R", rolePrompt: ".", actions: [] };
    reg.registerAgent({ name: "a1", team: "alpha", ...base });
    reg.registerAgent({ name: "a2", team: "alpha", ...base });
    reg.registerAgent({ name: "b1", team: "beta", ...base });
    reg.registerAgent({ name: "loner", ...base }); // no team

    expect(reg.getTeammates("a1").sort()).toEqual(["a2"]);
    expect(reg.getTeammates("b1")).toEqual([]);
    // A team-less agent sees every other agent as an available peer.
    expect(reg.getTeammates("loner").sort()).toEqual(["a1", "a2", "b1"]);
  });
});

describe("team-scoped delegation", () => {
  it("allows delegating to a teammate and scopes the child under the parent", async () => {
    let leadCalls = 0;
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole }) => {
        if (agentRole === "Lead") {
          leadCalls += 1;
          if (leadCalls === 1) return Ok({ kind: "delegate", delegation: { goal: "sub", agentName: "worker" } });
          return Ok({ kind: "done" });
        }
        return Ok({ kind: "done" }); // the worker finishes immediately
      },
    };
    const delta = await createDeltaEngine({ reasoner });
    const lead = anAction(delta, "plan");
    const work = anAction(delta, "do");
    delta.deploy(delta.agent({ name: "lead", description: "d", role: "Lead", rolePrompt: ".", team: "alpha", actions: [lead] }));
    delta.deploy(delta.agent({ name: "worker", description: "d", role: "Worker", rolePrompt: ".", team: "alpha", actions: [work] }));

    const result = await delta.send({ goal: "lead the work", agentName: "lead" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // The delegated child exists and is scoped under the parent's root.
    const child = await delta.lastTask("worker");
    expect(child.isOk).toBe(true);
    if (child.isOk && child.value !== null) {
      expect(child.value.rootId).toBe(result.value.taskId);
    }
  });

  it("rejects delegating across teams", async () => {
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole }) =>
        agentRole === "Lead"
          ? Ok({ kind: "delegate", delegation: { goal: "sub", agentName: "outsider" } })
          : Ok({ kind: "done" }),
    };
    const delta = await createDeltaEngine({ reasoner });
    delta.deploy(delta.agent({ name: "lead", description: "d", role: "Lead", rolePrompt: ".", team: "alpha", actions: [anAction(delta, "plan")] }));
    delta.deploy(delta.agent({ name: "outsider", description: "d", role: "Out", rolePrompt: ".", team: "beta", actions: [anAction(delta, "do")] }));

    const result = await delta.send({ goal: "delegate across teams", agentName: "lead" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/not a teammate/);
  });
});

describe("mentions", () => {
  it("records a TaskID-attributable note to a teammate (no child task)", async () => {
    let calls = 0;
    const reasoner: ReasonerPort = {
      reason: async () => {
        calls += 1;
        if (calls === 1) return Ok({ kind: "mention", mention: { agentName: "worker", message: "heads up, see the order" } });
        return Ok({ kind: "done" });
      },
    };
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner });
    delta.deploy(delta.agent({ name: "lead", description: "d", role: "Lead", rolePrompt: ".", team: "alpha", actions: [anAction(delta, "plan")] }));
    delta.deploy(delta.agent({ name: "worker", description: "d", role: "Worker", rolePrompt: ".", team: "alpha", actions: [anAction(delta, "do")] }));

    const result = await delta.send({ goal: "loop in the worker", agentName: "lead" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");

    // The mention was recorded as an agent-to-agent message on this task.
    const messages = await store.getMessages(result.value.taskId);
    expect(messages.isOk).toBe(true);
    if (!messages.isOk) return;
    const mention = messages.value.find((m) => m.sender === "lead" && m.receiver === "worker");
    expect(mention).toBeDefined();
    expect(mention?.payload).toBe("heads up, see the order");

    // No child task was spawned (mention is not delegation).
    const child = await delta.lastTask("worker");
    expect(child.isOk).toBe(true);
    if (child.isOk) expect(child.value).toBeNull();
  });

  it("delivers a mention into the recipient's reasoning context exactly once", async () => {
    const workerContexts: Array<string | undefined> = [];
    let leadMentioned = false;
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole, context }) => {
        if (agentRole === "Lead") {
          if (!leadMentioned) {
            leadMentioned = true;
            return Ok({ kind: "mention", mention: { agentName: "worker", message: "check order O-1" } });
          }
          return Ok({ kind: "done" });
        }
        // Worker: record the context it was given, then finish.
        workerContexts.push(context);
        return Ok({ kind: "done" });
      },
    };
    const delta = await createDeltaEngine({ reasoner });
    delta.deploy(delta.agent({ name: "lead", description: "d", role: "Lead", rolePrompt: ".", team: "alpha", actions: [anAction(delta, "plan")] }));
    delta.deploy(delta.agent({ name: "worker", description: "d", role: "Worker", rolePrompt: ".", team: "alpha", actions: [anAction(delta, "do")] }));

    // The lead mentions the worker (records an undelivered note).
    const mentioned = await delta.send({ goal: "loop in worker", agentName: "lead" });
    expect(mentioned.isOk).toBe(true);

    // The worker runs: the mention is folded into its reasoning context.
    const first = await delta.send({ goal: "do work", agentName: "worker" });
    expect(first.isOk).toBe(true);
    expect(workerContexts[0]).toContain("Teammate lead mentioned you: check order O-1");

    // The worker runs again: the mention was consumed, so it is not redelivered.
    const second = await delta.send({ goal: "do more work", agentName: "worker" });
    expect(second.isOk).toBe(true);
    expect(workerContexts[1] ?? "").not.toContain("check order O-1");
  });

  it("rejects mentioning a non-teammate", async () => {
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole }) =>
        agentRole === "Lead"
          ? Ok({ kind: "mention", mention: { agentName: "outsider", message: "hi" } })
          : Ok({ kind: "done" }),
    };
    const delta = await createDeltaEngine({ reasoner });
    delta.deploy(delta.agent({ name: "lead", description: "d", role: "Lead", rolePrompt: ".", team: "alpha", actions: [anAction(delta, "plan")] }));
    delta.deploy(delta.agent({ name: "outsider", description: "d", role: "Out", rolePrompt: ".", team: "beta", actions: [anAction(delta, "do")] }));

    const result = await delta.send({ goal: "mention an outsider", agentName: "lead" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/not a teammate/);
  });
});
