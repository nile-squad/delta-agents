/**
 * Roster integration: engine.roster() as a developer read-model, and the roster
 * reaching the reasoner during a live send so agents route work by teammate load.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { initialRiskState, initialTrust } from "../../src/governance";
import type { Task, RosterEntry } from "../../src/shared/types";
import type { ReasonerPort, ReasonerInput } from "../../src/ports/reasoner-port";

const runningTask = (id: string, agent: string, goal: string): Task => ({
  id,
  rootId: id,
  status: "running",
  goal,
  assignedAgent: agent,
  budget: { tokens: 100, durationMs: 1000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const anAction = (delta: Awaited<ReturnType<typeof createDeltaEngine>>, name: string) =>
  delta.action({ name, description: "work", schema: z.object({}), fn: async () => Ok("ok") });

describe("engine.roster()", () => {
  it("reports per-agent load and filters by team", async () => {
    const store = createInMemoryStore();
    // Pre-seed a running task so "worker" shows as busy without standing up a live loop.
    await store.saveTask(runningTask("t-busy", "worker", "crunching numbers"));

    const reasoner: ReasonerPort = { reason: async () => Ok({ kind: "done" }) };
    const delta = await createDeltaEngine({ reasoner, store });
    const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "noop")] };
    delta.deploy(delta.agent({ name: "lead", role: "Lead", team: "alpha", ...base }));
    delta.deploy(delta.agent({ name: "worker", role: "Worker", team: "alpha", ...base }));
    delta.deploy(delta.agent({ name: "outsider", role: "Outsider", team: "beta", ...base }));

    const all = await delta.roster();
    expect(all.isOk).toBe(true);
    if (!all.isOk) return;
    expect(all.value.map((r) => r.agent).sort()).toEqual(["lead", "outsider", "worker"]);
    const worker = all.value.find((r) => r.agent === "worker") as RosterEntry;
    expect(worker.status).toBe("busy");
    expect(worker.doing?.goal).toBe("crunching numbers");
    const lead = all.value.find((r) => r.agent === "lead") as RosterEntry;
    expect(lead.status).toBe("idle");

    const alpha = await delta.roster({ team: "alpha" });
    expect(alpha.isOk).toBe(true);
    if (!alpha.isOk) return;
    expect(alpha.value.map((r) => r.agent).sort()).toEqual(["lead", "worker"]);
  });
});

describe("roster reaches the reasoner during a send", () => {
  it("passes a load-aware roster of teammates into the reasoning input", async () => {
    const store = createInMemoryStore();
    await store.saveTask(runningTask("t-worker", "worker", "existing work"));

    let captured: ReasonerInput | undefined;
    const reasoner: ReasonerPort = {
      reason: async (input) => {
        if (input.agentRole === "Lead") captured = input;
        return Ok({ kind: "done" });
      },
    };
    const delta = await createDeltaEngine({ reasoner, store });
    const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "noop")] };
    delta.deploy(delta.agent({ name: "lead", role: "Lead", team: "alpha", ...base }));
    delta.deploy(delta.agent({ name: "worker", role: "Worker", team: "alpha", ...base }));

    const result = await delta.send({ goal: "lead the work", agentName: "lead" });
    expect(result.isOk).toBe(true);
    expect(captured).toBeDefined();
    const roster = captured?.roster ?? [];
    const worker = roster.find((r) => r.agent === "worker");
    expect(worker).toBeDefined();
    expect(worker?.status).toBe("busy");
  });
});
