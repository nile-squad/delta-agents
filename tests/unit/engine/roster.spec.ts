/**
 * Team roster tests: the derived "who is doing what, how loaded" read-model.
 *
 *   - computeRosterEntries classifies major vs subtask load, counts queued
 *     caller-backlog, flags overload, and reports idle agents as idle.
 *   - buildMessages renders the roster block into the reasoner's user message
 *     (load-aware), replacing the bare teammate name list.
 */

import { describe, it, expect } from "vitest";
import { createInMemoryStore } from "../../../src/ports";
import { computeRosterEntries } from "../../../src/engine/roster";
import { buildMessages } from "../../../src/ports/openai-reasoner";
import { initialRiskState, initialTrust } from "../../../src/governance";
import type { Task, Message, RosterEntry } from "../../../src/shared/types";
import type { ReasonerInput } from "../../../src/ports/reasoner-port";

const aTask = (over: Partial<Task> & Pick<Task, "id" | "assignedAgent" | "status">): Task => ({
  rootId: over.id,
  goal: "do the thing",
  budget: { tokens: 100, durationMs: 1000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("computeRosterEntries", () => {
  it("reports a busy agent's major task, subtask load, queued backlog, and overload", async () => {
    const store = createInMemoryStore();
    await store.saveTask(aTask({ id: "t1", assignedAgent: "researcher", status: "running", goal: "Summarize Q3 filings", currentPhase: "extract" }));
    // Two active subtasks (parentId set) → fills the 2 subtask slots.
    await store.saveTask(aTask({ id: "s1", assignedAgent: "researcher", status: "running", parentId: "t1" }));
    await store.saveTask(aTask({ id: "s2", assignedAgent: "researcher", status: "pending", parentId: "t1" }));
    // A completed task must not count toward load.
    await store.saveTask(aTask({ id: "done1", assignedAgent: "researcher", status: "completed" }));
    // One queued caller goal (unconsumed) → backlog of 1.
    const msg: Message = { id: "m1", taskId: "t1", sender: "caller", receiver: "researcher", payload: "also do X", createdAt: new Date() };
    await store.saveMessage(msg);

    const [entry] = await computeRosterEntries({ store, agentNames: ["researcher"] });
    expect(entry).toBeDefined();
    const e = entry as RosterEntry;
    expect(e.status).toBe("busy");
    expect(e.doing).toEqual({ taskId: "t1", goal: "Summarize Q3 filings", phase: "extract" });
    expect(e.load.major).toBe(1);
    expect(e.load.subtasks).toBe(2);
    expect(e.load.queued).toBe(1);
    expect(e.load.capacity).toBe("3/3");
    expect(e.load.overloaded).toBe(true);
  });

  it("reports an agent with no active tasks as idle and not overloaded", async () => {
    const store = createInMemoryStore();
    await store.saveTask(aTask({ id: "old", assignedAgent: "writer", status: "completed" }));

    const [entry] = await computeRosterEntries({ store, agentNames: ["writer"] });
    const e = entry as RosterEntry;
    expect(e.status).toBe("idle");
    expect(e.doing).toBeNull();
    expect(e.load).toMatchObject({ major: 0, subtasks: 0, queued: 0, capacity: "0/3", overloaded: false });
  });
});

describe("buildMessages roster rendering", () => {
  const base: ReasonerInput = {
    task: aTask({ id: "cur", assignedAgent: "lead", status: "running" }),
    availableActions: ["plan"],
    agentRole: "Lead",
    rolePrompt: "lead the work",
  };

  it("renders a load-aware roster block instead of the bare teammate list", () => {
    const roster: RosterEntry[] = [
      { agent: "researcher", status: "busy", doing: { taskId: "t1", goal: "Summarize Q3", phase: "extract" }, load: { major: 1, subtasks: 2, queued: 3, capacity: "3/3", overloaded: true } },
      { agent: "writer", status: "idle", doing: null, load: { major: 0, subtasks: 0, queued: 0, capacity: "0/3", overloaded: false } },
    ];
    const user = buildMessages({ ...base, availableAgents: ["researcher", "writer"], roster })[1]!;
    const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    expect(text).toContain("Team roster");
    expect(text).toContain("researcher — busy (OVERLOADED)");
    expect(text).toContain("Summarize Q3");
    expect(text).toContain("writer — idle");
    // The bare fallback line is not used when a roster is present.
    expect(text).not.toContain("Available teammates (to delegate to or mention)");
  });

  it("falls back to the bare teammate list when no roster is provided", () => {
    const user = buildMessages({ ...base, availableAgents: ["writer"] })[1]!;
    const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    expect(text).toContain("Available teammates (to delegate to or mention): writer");
  });
});
