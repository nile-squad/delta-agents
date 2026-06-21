/**
 * Engine-on-real-DB lifecycle tests (J3).
 *
 * WHY: tests/integration/drizzle-store.spec.ts proves every StoragePort method
 * works against a real libsql database, but it never drives the actual engine
 * through that store. These tests close that gap: they wire a real libsql FILE
 * store into createDeltaEngine and run the full governance lifecycle
 * (send -> execute -> checkpoint -> inspect -> resume) end to end.
 *
 * The strongest proof here is cross-instance persistence: one engine writes a
 * task's blocked state to a file on disk, then a completely fresh store instance
 * (a new connection to the same file, as a process restart would create) reads
 * that state back and resumes the task to completion. This is the property an
 * in-memory store can never demonstrate.
 */

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeltaEngine } from "../../src/engine";
import { createDrizzleStore } from "../../src/ports/drizzle-store";
import { createMockReasoner } from "../../src/ports/mock-reasoner";

// Each test creates an isolated temp directory for its libsql file (plus the
// -wal/-shm sidecars libsql may create) and removes the whole directory after.
// This is ephemeral OS-temp scratch the test itself creates, not project state.
const tempDirs: string[] = [];

const freshDbUrl = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "delta-j3-"));
  tempDirs.push(dir);
  return `file:${join(dir, "delta.db")}`;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("engine on real libsql — full lifecycle (J3)", () => {
  it("drives a task to completion against a file store and persists the audit trail", async () => {
    const url = await freshDbUrl();
    const store = await createDrizzleStore(url);

    const delta = createDeltaEngine({
      store,
      reasoner: createMockReasoner({ responses: [{ actionName: "record", input: { value: 7 } }] }),
    });

    const ran: string[] = [];
    const record = delta.action({
      name: "record",
      description: "record a value",
      schema: z.object({ value: z.number() }),
      fn: async ({ value }) => {
        ran.push(`recorded ${value}`);
        return Ok(`recorded ${value}`);
      },
    });
    const agent = delta.agent({
      name: "recorder",
      description: "records values",
      role: "Recorder",
      rolePrompt: "Record the value.",
      actions: [record],
    });
    delta.deploy(agent);

    const result = await delta.send({ goal: "record 7", agentName: "recorder" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(ran).toEqual(["recorded 7"]);

    // The audit trail must have survived the round-trip through real SQLite
    // columns (including the JSON-encoded snapshot, cost, risk, and trust).
    const inspection = await delta.inspect(result.value.taskId);
    expect(inspection.isOk).toBe(true);
    if (!inspection.isOk) return;
    expect(inspection.value.task.status).toBe("completed");
    expect(inspection.value.executions.length).toBeGreaterThan(0);
    expect(inspection.value.executions[0]?.action).toBe("record");
    // A checkpoint is written after each successful action; it must be readable.
    expect(inspection.value.latestCheckpoint).not.toBeNull();
  });

  it("a fresh store instance on the same file reads a completed task back (cross-instance persistence)", async () => {
    const url = await freshDbUrl();

    // ── Engine A: run a task to completion, then drop the store instance. ──────
    const storeA = await createDrizzleStore(url);
    const deltaA = createDeltaEngine({
      store: storeA,
      reasoner: createMockReasoner({ responses: [{ actionName: "act", input: {} }] }),
    });
    const actA = deltaA.action({ name: "act", description: "noop", schema: z.object({}), fn: async () => Ok("ok") });
    const agentA = deltaA.agent({
      name: "persist-agent",
      description: "persists",
      role: "R",
      rolePrompt: ".",
      actions: [actA],
    });
    deltaA.deploy(agentA);

    const sent = await deltaA.send({ goal: "do it", agentName: "persist-agent" });
    expect(sent.isOk).toBe(true);
    if (!sent.isOk) return;
    const taskId = sent.value.taskId;

    // ── Engine B: brand-new connection to the same file (a process restart). ──
    const storeB = await createDrizzleStore(url);
    const deltaB = createDeltaEngine({
      store: storeB,
      reasoner: createMockReasoner({ responses: [] }),
    });
    const actB = deltaB.action({ name: "act", description: "noop", schema: z.object({}), fn: async () => Ok("ok") });
    const agentB = deltaB.agent({
      name: "persist-agent",
      description: "persists",
      role: "R",
      rolePrompt: ".",
      actions: [actB],
    });
    deltaB.deploy(agentB);

    // The task written by engine A is visible to engine B's fresh store.
    const inspected = await deltaB.inspect(taskId);
    expect(inspected.isOk).toBe(true);
    if (inspected.isOk) {
      expect(inspected.value.task.id).toBe(taskId);
      expect(inspected.value.task.status).toBe("completed");
      expect(inspected.value.executions.length).toBeGreaterThan(0);
    }

    // lastTask works across the instance boundary too (invariant 25).
    const last = await deltaB.lastTask("persist-agent");
    expect(last.isOk).toBe(true);
    if (last.isOk) expect(last.value?.id).toBe(taskId);
  });

  it("resumes a blocked task from a file written by a different engine instance", async () => {
    const url = await freshDbUrl();
    const executed: string[] = [];

    // ── Engine A: send hits an approval gate and blocks; state is on disk. ────
    const storeA = await createDrizzleStore(url);
    const deltaA = createDeltaEngine({
      store: storeA,
      reasoner: createMockReasoner({ responses: [{ actionName: "pay", input: { amount: 100 } }] }),
    });
    const payA = deltaA.action({
      name: "pay",
      description: "send payment",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: async () => {
        executed.push("paid");
        return Ok("paid");
      },
    });
    const agentA = deltaA.agent({
      name: "payer",
      description: "pays",
      role: "R",
      rolePrompt: ".",
      actions: [payA],
    });
    deltaA.deploy(agentA);

    const blocked = await deltaA.send({ goal: "pay 100", agentName: "payer" });
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk || blocked.value.status !== "blocked") return;
    const taskId = blocked.value.taskId;

    // Approve through engine A (writes the resolved approval to disk).
    const approvalId = blocked.value.reason?.match(/appr_\S+/)?.[0];
    expect(approvalId).toBeDefined();
    if (approvalId === undefined) return;
    await deltaA.approve(approvalId);

    // ── Engine B: fresh connection to the same file resumes to completion. ────
    const storeB = await createDrizzleStore(url);
    const deltaB = createDeltaEngine({
      store: storeB,
      reasoner: createMockReasoner({ responses: [{ actionName: "pay", input: { amount: 100 } }] }),
    });
    const payB = deltaB.action({
      name: "pay",
      description: "send payment",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: async () => {
        executed.push("paid-resumed");
        return Ok("paid");
      },
    });
    const agentB = deltaB.agent({
      name: "payer",
      description: "pays",
      role: "R",
      rolePrompt: ".",
      actions: [payB],
    });
    deltaB.deploy(agentB);

    const resumed = await deltaB.resume(taskId);
    expect(resumed.isOk).toBe(true);
    if (resumed.isOk) expect(resumed.value.status).toBe("completed");
    // The action ran only after resume on the second instance, never on the first
    // (the first send blocked before fn execution).
    expect(executed).toEqual(["paid-resumed"]);
  });
});
