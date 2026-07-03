/**
 * Memory ranking, retrieval, and write-helper tests.
 *
 * rankMemories is the pure relevance signal (keyword overlap, recency tiebreak).
 * retrieveContext + makeContextRemember are the on-demand read/write loop
 * (spec principle 4: memory is retrieved, not carried).
 */

import { describe, it, expect } from "vitest";
import { rankMemories, retrieveContext, makeContextRemember } from "../../../src/memory";
import { createInMemoryStore } from "../../../src/ports";
import type { Memory } from "../../../src/shared/types";

const mem = (id: string, content: string, createdAt: Date, agentName = "a"): Memory => ({
  id, taskId: "t", agentName, kind: "note", content, createdAt,
});

describe("rankMemories", () => {
  it("ranks by keyword overlap with the query", () => {
    const memories = [
      mem("1", "the cat sat on the mat", new Date(3)),
      mem("2", "quarterly revenue report numbers", new Date(2)),
      mem("3", "revenue grew this quarter", new Date(1)),
    ];
    const ranked = rankMemories({ memories, query: "revenue quarter", limit: 2 });
    expect(ranked.map((m) => m.id)).toEqual(["3", "2"]);
  });

  it("falls back to recency when nothing overlaps (input is most-recent-first)", () => {
    const memories = [mem("new", "alpha", new Date(3)), mem("old", "beta", new Date(1))];
    const ranked = rankMemories({ memories, query: "zzz", limit: 1 });
    expect(ranked[0]?.id).toBe("new");
  });

  it("respects the limit", () => {
    const memories = [mem("1", "a", new Date(3)), mem("2", "b", new Date(2)), mem("3", "c", new Date(1))];
    expect(rankMemories({ memories, query: "x", limit: 2 })).toHaveLength(2);
  });
});

describe("retrieveContext + makeContextRemember", () => {
  it("remembers a memory and retrieves it as formatted context", async () => {
    const store = createInMemoryStore();
    const remember = makeContextRemember({ store, taskId: "t1", agentName: "agent-x" });
    await remember("customer prefers email", "preference");

    const retrieved = await retrieveContext({ store, agentName: "agent-x", query: "how to contact the customer by email" });
    expect(retrieved.memories).toHaveLength(1);
    expect(retrieved.context).toMatch(/\(preference\) customer prefers email/);
  });

  it("returns empty context when the agent has no memories", async () => {
    const store = createInMemoryStore();
    const retrieved = await retrieveContext({ store, agentName: "nobody", query: "x" });
    expect(retrieved.context).toBe("");
    expect(retrieved.memories).toEqual([]);
  });

  it("scopes memories to the owning agent", async () => {
    const store = createInMemoryStore();
    await makeContextRemember({ store, taskId: "t", agentName: "a" })("a-secret");
    await makeContextRemember({ store, taskId: "t", agentName: "b" })("b-secret");
    const ra = await retrieveContext({ store, agentName: "a", query: "secret" });
    expect(ra.memories.map((m) => m.content)).toEqual(["a-secret"]);
  });
});

describe("StoragePort memory methods (in-memory)", () => {
  it("saveMemory + getMemoriesByAgent returns newest-first, capped to limit", async () => {
    const store = createInMemoryStore();
    await store.saveMemory(mem("1", "first", new Date(1), "a"));
    await store.saveMemory(mem("2", "second", new Date(2), "a"));
    await store.saveMemory(mem("3", "third", new Date(3), "a"));
    const r = await store.getMemoriesByAgent("a", 2);
    expect(r.isOk).toBe(true);
    if (r.isOk) expect(r.value.map((m) => m.id)).toEqual(["3", "2"]);
  });
});
