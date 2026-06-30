/**
 * Time awareness + system prompt — engine grounds the model with current time,
 * prior conversation (relative time), and org-level instructions.
 *
 * - systemPrompt is static + baked into the system prefix (cacheable)
 * - currentTimestamp + priorMessages ride in the user message (varying)
 * - prior messages are loaded from the store with formatDistanceToNow labels
 *
 * The cacheable prefix invariant (systemPrompt in system, time in user) is
 * the load-bearing one: a time string in the system prefix would invalidate
 * the prompt cache on every call.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { subHours, subDays } from "date-fns";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { buildMessages } from "../../src/ports/openai-reasoner";
import { taskId, checkpointId, messageId } from "../../src/shared/id";
import { initialRiskState, initialTrust } from "../../src/governance";
import type { ReasonerInput } from "../../src/ports/reasoner-port";
import type { ReasonerPort } from "../../src/ports/reasoner-port";
import type { JsonRecord } from "../../src/shared/types";

const noop = async () => Ok("ok");

// Capture-reasoner holder — use an array (not `let x: T | null`) so TS
// narrowing does not freeze `x` to its initial value after the async
// callback mutates it. Same pattern as storyline.spec.ts.
const makeCapture = () => {
  const captured: ReasonerInput[] = [];
  const reasoner: ReasonerPort = {
    reason: async (input) => {
      captured.push(input);
      return Ok({ kind: "done" });
    },
  };
  return { captured, reasoner };
};

// Build a minimal ReasonerInput for buildMessages() — the only fields it reads
// beyond the time-awareness additions are task/agent/prompt + action lists.
const baseReasonerInput = (overrides: Partial<ReasonerInput> = {}): ReasonerInput => ({
  task: {
    id: "tsk_test",
    rootId: "tsk_test",
    status: "running",
    goal: "do the thing",
    assignedAgent: "agent-x",
    budget: { tokens: 10_000, durationMs: 300_000 },
    risk: initialRiskState(),
    trust: initialTrust(),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  availableActions: ["act"],
  availableAgents: [],
  availableChannels: [],
  agentRole: "Tester",
  rolePrompt: "Test things.",
  ...overrides,
});

describe("systemPrompt — org instructions baked into the cacheable system prefix", () => {
  it("appears in the system message content via buildMessages (cacheable prefix)", () => {
    const messages = buildMessages(
      baseReasonerInput({
        systemPrompt: "You are an Acme Corp agent. Always be helpful.",
      }),
    );
    const systemMsg = messages[0];
    expect(systemMsg?.role).toBe("system");
    const content = typeof systemMsg?.content === "string"
      ? systemMsg?.content
      : Array.isArray(systemMsg?.content) ? systemMsg?.content.join("") : "";
    // The systemPrompt must be the FIRST thing in the system message — the
    // whole point is that the prefix is cacheable, so it goes before the role.
    expect(content).toMatch(/^You are an Acme Corp agent\. Always be helpful\.\n\nYou are Tester\. Test things\./);
  });

  it("does NOT appear in the user message (cache safety — varying content stays out of the prefix)", () => {
    const messages = buildMessages(
      baseReasonerInput({
        systemPrompt: "ORGSECRET-MUST-NOT-LEAK-INTO-USER",
      }),
    );
    const userMsg = messages[1];
    expect(userMsg?.role).toBe("user");
    const userContent = typeof userMsg?.content === "string"
      ? userMsg?.content
      : Array.isArray(userMsg?.content) ? userMsg?.content.join("") : "";
    expect(userContent).not.toContain("ORGSECRET-MUST-NOT-LEAK-INTO-USER");
  });

  it("omitted from system message when not configured (no stray empty prefix line)", () => {
    const messages = buildMessages(baseReasonerInput());
    const systemMsg = messages[0];
    const content = typeof systemMsg?.content === "string"
      ? systemMsg?.content
      : Array.isArray(systemMsg?.content) ? systemMsg?.content.join("") : "";
    expect(content).toMatch(/^You are Tester\. Test things\./);
  });
});

describe("currentTimestamp — engine grounds the model with time", () => {
  it("reasoner receives a currentTimestamp with iso, humanized, timezone", async () => {
    const { captured, reasoner } = makeCapture();
    const delta = await createDeltaEngine({ reasoner, timezone: "UTC" });
    const act = delta.action({ name: "act", description: "test", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "ts-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    await delta.send({ goal: "go", agentName: "ts-agent" });

    expect(captured.length).toBeGreaterThan(0);
    const last = captured[captured.length - 1]!;
    expect(last.currentTimestamp).toBeDefined();
    const ts = last.currentTimestamp!;
    // ISO-8601 sanity: round-trips to a Date close to now.
    expect(() => new Date(ts.iso)).not.toThrow();
    const parsed = new Date(ts.iso);
    expect(Math.abs(parsed.getTime() - Date.now())).toBeLessThan(5_000);
    expect(typeof ts.humanized).toBe("string");
    expect(ts.humanized.length).toBeGreaterThan(0);
    expect(ts.timezone).toBe("UTC");
  });

  it("uses system timezone when none configured", async () => {
    const { captured, reasoner } = makeCapture();
    const delta = await createDeltaEngine({ reasoner });
    const act = delta.action({ name: "act", description: "test", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "tz-default", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    await delta.send({ goal: "go", agentName: "tz-default" });

    const last = captured[captured.length - 1]!;
    expect(last.currentTimestamp?.timezone.length).toBeGreaterThan(0);
  });

  it("prepended to user message in buildMessages, not the system message", () => {
    const now = new Date("2026-07-01T14:30:00Z");
    const messages = buildMessages(
      baseReasonerInput({
        currentTimestamp: {
          iso: now.toISOString(),
          humanized: "2:30 PM UTC",
          timezone: "UTC",
        },
      }),
    );
    const systemContent = typeof messages[0]?.content === "string"
      ? messages[0]?.content
      : Array.isArray(messages[0]?.content) ? messages[0]?.content.join("") : "";
    expect(systemContent).not.toContain("Current time");
    const userContent = typeof messages[1]?.content === "string"
      ? messages[1]?.content
      : Array.isArray(messages[1]?.content) ? messages[1]?.content.join("") : "";
    expect(userContent).toMatch(/^Current time: 2:30 PM UTC \(2026-07-01T14:30:00\.000Z\)/);
  });
});

describe("priorMessages — older conversation given to the model with relative time", () => {
  it("loads messages from the store and labels them with formatDistanceToNow", async () => {
    const store = createInMemoryStore();
    const { captured, reasoner } = makeCapture();

    // Seed a paused task + checkpoint so resume() can re-enter the reasoner
    // loop on a real TaskID (sending a new goal would create a fresh task
    // with no prior messages, defeating the test).
    const id = taskId();
    const now = new Date();
    const budget = { tokens: 10_000, durationMs: 300_000 };
    await store.saveTask({
      id,
      rootId: id,
      status: "paused",
      goal: "resume with prior",
      assignedAgent: "pm-agent",
      budget,
      risk: initialRiskState(),
      trust: initialTrust(),
      createdAt: now,
      updatedAt: now,
    });
    const snapshot: JsonRecord = {
      taskId: id, rootId: id, agentName: "pm-agent", status: "paused",
      completedActions: [], completedWorkflows: [],
      budget, spent: { tokens: 0, durationMs: 0 },
      risk: initialRiskState() as unknown as JsonRecord, trust: initialTrust() as unknown as JsonRecord,
    };
    await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: snapshot, createdAt: now });

    // Seed messages with old timestamps so the relative-time labels are
    // deterministic. formatDistanceToNow produces "about 4 hours ago" etc.
    const fourHoursAgo = subHours(new Date(), 4);
    const twoDaysAgo = subDays(new Date(), 2);
    await store.saveMessage({
      id: messageId(),
      taskId: id,
      sender: "alice",
      receiver: "pm-agent",
      payload: "can you check on the order?",
      createdAt: twoDaysAgo,
    });
    await store.saveMessage({
      id: messageId(),
      taskId: id,
      sender: "pm-agent",
      receiver: "alice",
      payload: "looking into it now",
      createdAt: fourHoursAgo,
    });

    const delta = await createDeltaEngine({ store, reasoner });
    const act = delta.action({ name: "act", description: "test", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "pm-agent", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    // Resume — the reasoner runs, captures the input, then signals done.
    const result = await delta.resume(id);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const last = captured[captured.length - 1]!;
    expect(last.priorMessages).toBeDefined();
    const prior = last.priorMessages!;
    expect(prior.length).toBe(2);
    // Sorted oldest first — the model sees the conversation in order.
    expect(prior[0]?.sender).toBe("alice");
    expect(prior[0]?.content).toBe("can you check on the order?");
    expect(prior[0]?.relativeTime).toMatch(/ago/);
    expect(prior[1]?.sender).toBe("pm-agent");
    expect(prior[1]?.content).toBe("looking into it now");
    expect(prior[1]?.relativeTime).toMatch(/ago/);
  });

  it("absent when the store has no messages (omitted, not an empty array)", async () => {
    const { captured, reasoner } = makeCapture();
    const delta = await createDeltaEngine({ reasoner });
    const act = delta.action({ name: "act", description: "test", schema: z.object({}), fn: noop });
    delta.deploy(delta.agent({ name: "empty-pm", description: "d", role: "r", rolePrompt: ".", actions: [act] }));

    await delta.send({ goal: "go", agentName: "empty-pm" });

    const last = captured[captured.length - 1]!;
    expect(last.priorMessages).toBeUndefined();
  });

  it("renders in buildMessages user content as `[relative] sender: content` lines", () => {
    const messages = buildMessages(
      baseReasonerInput({
        priorMessages: [
          { sender: "alice", content: "ping", relativeTime: "4 hours ago" },
          { sender: "bob", content: "pong", relativeTime: "2 days ago" },
        ],
      }),
    );
    const userContent = typeof messages[1]?.content === "string"
      ? messages[1]?.content
      : Array.isArray(messages[1]?.content) ? messages[1]?.content.join("") : "";
    expect(userContent).toContain("Prior conversation:");
    expect(userContent).toContain("[4 hours ago] alice: ping");
    expect(userContent).toContain("[2 days ago] bob: pong");
  });
});
