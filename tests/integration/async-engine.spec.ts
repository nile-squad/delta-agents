/**
 * Async engine construction tests.
 *
 * createDeltaEngine is awaitable so an adapter that needs async warm-up (open a
 * connection, run migrations, ping the database) can gate construction on its
 * readiness. The engine awaits StoragePort.ready once and refuses to construct if
 * it returns Err, surfacing a data-layer problem at construction time rather than
 * on the first send.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";

describe("createDeltaEngine — async construction and store readiness", () => {
  it("awaits the store's ready() before the engine is usable", async () => {
    let readyCalledAt = 0;
    let saveCalledAt = 0;
    let tick = 0;
    const base = createInMemoryStore();
    const store = {
      ...base,
      ready: async () => {
        readyCalledAt = ++tick;
        return Ok(undefined);
      },
      saveTask: async (task: Parameters<typeof base.saveTask>[0]) => {
        if (saveCalledAt === 0) saveCalledAt = ++tick;
        return base.saveTask(task);
      },
    };

    const delta = await createDeltaEngine({ store });
    const act = delta.action({ name: "a", description: "do", schema: z.object({}), fn: async () => Ok("ok") });
    const agent = delta.agent({ name: "ag", description: "d", role: "R", rolePrompt: ".", actions: [act] });
    delta.deploy(agent);
    const result = await delta.send({ goal: "go", agentName: "ag" });

    expect(result.isOk).toBe(true);
    // ready() ran during construction, before the first store write of a send.
    expect(readyCalledAt).toBe(1);
    expect(saveCalledAt).toBeGreaterThan(readyCalledAt);
  });

  it("throws when the store reports it is not ready", async () => {
    const base = createInMemoryStore();
    const store = { ...base, ready: async () => Err("connection refused") };

    await expect(createDeltaEngine({ store })).rejects.toThrow(/not ready: connection refused/);
  });

  it("constructs without a ready hook (in-memory store has no async warm-up)", async () => {
    const delta = await createDeltaEngine();
    const act = delta.action({ name: "a", description: "do", schema: z.object({}), fn: async () => Ok("ok") });
    const agent = delta.agent({ name: "ag", description: "d", role: "R", rolePrompt: ".", actions: [act] });
    delta.deploy(agent);
    const result = await delta.send({ goal: "go", agentName: "ag" });
    expect(result.isOk).toBe(true);
  });
});
