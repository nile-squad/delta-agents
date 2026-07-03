/**
 * Tool execution + history + tool-info integration tests (Phase 3).
 *
 * Exercises the scheduler's tool branches end-to-end through `createDeltaEngine`:
 *   - `system:use_tool` — executes a registered tool, records the result in
 *     `TaskStateSnapshot.toolHistory`, stamps a token estimate, and continues.
 *   - `system:get_tool_schema` — returns a tool's JSON schema as
 *     `lastToolInfoResult`, visible to the model on its next turn.
 *   - `system:get_tool_history` — returns the full tool history.
 *   - `system:get_tool_history_entry` — returns a single full (untruncated) entry.
 *
 * Test 5 (tool history in user message) inspects the ReasonerInput the reasoner
 * actually sees, not just the snapshot, so the model-side wiring is verified
 * separately from the snapshot-side wiring.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import type { ReasonerPort, ReasonerInput, ReasonerDecision } from "../../src/ports/reasoner-port";
import type { ToolHistoryEntry } from "../../src/authoring/types";
import type { DeltaEngine } from "../../src/engine/types";

/** Capture every ReasonerInput the reasoner sees, in order. */
const captureReasoner = (
  decisions: () => ReasonerDecision | Promise<ReasonerDecision>,
): { reasoner: ReasonerPort; inputs: ReasonerInput[] } => {
  const inputs: ReasonerInput[] = [];
  const reasoner: ReasonerPort = {
    reason: async (input) => {
      inputs.push(input);
      return Ok(await decisions());
    },
  };
  return { reasoner, inputs };
};

/** Register a noop action on the engine and return it. */
const registerNoop = (delta: DeltaEngine) =>
  delta.action({ name: "finish", description: "noop", schema: z.object({}), fn: async () => Ok("ok") });

describe("tool execution: model requests a tool, scheduler runs it and records history", () => {
  it("executes a tool, records the entry, and continues the task", async () => {
    const store = createInMemoryStore();
    const seen: { toolName: string; input: unknown }[] = [];
    const tool = {
      name: "echo",
      description: "echo the input back",
      schema: z.object({ message: z.string() }),
      fn: async ({ data, ctx }: { data: unknown; ctx: { toolHistory: ToolHistoryEntry[] } }) => {
        const d = data as { message: string };
        seen.push({ toolName: "echo", input: d });
        return Ok({ echoed: d.message, priorHistoryLen: ctx.toolHistory.length });
      },
    };
    const calls: Array<() => ReasonerDecision | Promise<ReasonerDecision>> = [
      () => ({ kind: "tool", toolCall: { toolName: "echo", input: { message: "hello" } } }),
      () => ({ kind: "done" }),
    ];
    let i = 0;
    const { reasoner } = captureReasoner(() => {
      const next = calls[i++];
      return next ? next() : { kind: "done" };
    });
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "tool-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "use the tool", agentName: "tool-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");

    // The tool fn was called once with the model's input.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toEqual({ message: "hello" });

    // The history was persisted on the final snapshot.
    const history = result.value.snapshot.toolHistory;
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
    const entry = history?.[0];
    expect(entry?.toolName).toBe("echo");
    expect(entry?.input).toEqual({ message: "hello" });
    expect(entry?.agentName).toBe("tool-agent");
    expect(entry?.truncated).toBe(false);
    // Output was JSON-stringified (truncateToolOutput JSON.stringifies objects).
    const outputStr = typeof entry?.output === "string" ? entry.output : JSON.stringify(entry?.output);
    expect(outputStr).toMatch(/echoed.*hello/);
  });

  it("records a failed entry when the tool input fails schema validation, task continues", async () => {
    const store = createInMemoryStore();
    let called = false;
    const tool = {
      name: "strict",
      description: "strict schema",
      schema: z.object({ count: z.number() }),
      fn: async () => { called = true; return Ok("ok"); },
    };
    const calls: Array<() => ReasonerDecision> = [
      () => ({ kind: "tool", toolCall: { toolName: "strict", input: { count: "not a number" } } }),
      () => ({ kind: "done" }),
    ];
    let i = 0;
    const { reasoner } = captureReasoner(() => calls[i++]!());
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "strict-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "bad input", agentName: "strict-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The task continued past the schema failure and finished cleanly.
    expect(result.value.status).toBe("completed");
    // The tool fn was never called — schema validation blocked it.
    expect(called).toBe(false);

    const history = result.value.snapshot.toolHistory;
    expect(history).toHaveLength(1);
    const entry = history?.[0];
    expect(entry?.toolName).toBe("strict");
    // Error captured in the output field as a JSON-encoded error envelope.
    const outputStr = typeof entry?.output === "string" ? entry.output : JSON.stringify(entry?.output);
    expect(outputStr).toMatch(/schema-invalid/);
  });

  it("records a failed entry when the tool fn returns Err, task continues", async () => {
    const store = createInMemoryStore();
    const tool = {
      name: "flaky",
      description: "always fails",
      schema: z.object({}),
      fn: async () => Err("upstream timeout"),
    };
    const calls: Array<() => ReasonerDecision> = [
      () => ({ kind: "tool", toolCall: { toolName: "flaky", input: {} } }),
      () => ({ kind: "done" }),
    ];
    let i = 0;
    const { reasoner } = captureReasoner(() => calls[i++]!());
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "flaky-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "use flaky", agentName: "flaky-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");

    const history = result.value.snapshot.toolHistory;
    expect(history).toHaveLength(1);
    const outputStr = typeof history?.[0]?.output === "string" ? history[0].output : JSON.stringify(history?.[0]?.output);
    expect(outputStr).toMatch(/upstream timeout/);
  });
});

describe("tool-info: model fetches schema / history / entry", () => {
  it("schema request stores lastToolInfoResult, model sees it next turn", async () => {
    const store = createInMemoryStore();
    const tool = {
      name: "web-search",
      description: "search the web",
      schema: z.object({ query: z.string() }),
      fn: async () => Ok("ok"),
    };
    const { reasoner, inputs } = captureReasoner((() => {
      let i = 0;
      return async () => {
        const call = i++;
        if (call === 0) return { kind: "tool-info", request: { type: "schema", toolName: "web-search" } };
        return { kind: "done" };
      };
    })());
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "info-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "what is the input shape", agentName: "info-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(result.value.snapshot.lastToolInfoResult).toBeDefined();

    // The second reasoner call saw the schema in its ReasonerInput.
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(inputs[1]?.toolInfoResult).toBeDefined();
    expect(inputs[1]?.toolInfoResult).toMatch(/web-search/);
    expect(inputs[1]?.toolInfoResult).toMatch(/properties/);
  });

  it("get_tool_history returns the full history", async () => {
    const store = createInMemoryStore();
    const tool = {
      name: "echo",
      description: "echo",
      schema: z.object({ message: z.string() }),
      fn: async ({ data }: { data: unknown }) => Ok({ echoed: (data as { message: string }).message }),
    };
    const { reasoner, inputs } = captureReasoner((() => {
      let i = 0;
      return async () => {
        const call = i++;
        if (call === 0) return { kind: "tool", toolCall: { toolName: "echo", input: { message: "first" } } };
        if (call === 1) return { kind: "tool-info", request: { type: "history" } };
        return { kind: "done" };
      };
    })());
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "hist-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "use then review", agentName: "hist-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // The third reasoner call saw the full history in its input.
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    expect(inputs[2]?.toolInfoResult).toBeDefined();
    expect(inputs[2]?.toolInfoResult).toMatch(/toolHistory/);
    expect(inputs[2]?.toolInfoResult).toMatch(/echo/);
  });

  it("get_tool_history_entry returns a full (untruncated) entry by index", async () => {
    const store = createInMemoryStore();
    // Build a tool that returns a large output (>500 chars) so it gets truncated.
    const bigOutput = "x".repeat(1_000);
    const tool = {
      name: "verbose",
      description: "big output",
      schema: z.object({}),
      fn: async () => Ok({ text: bigOutput }),
    };
    const { reasoner, inputs } = captureReasoner((() => {
      let i = 0;
      return async () => {
        const call = i++;
        if (call === 0) return { kind: "tool", toolCall: { toolName: "verbose", input: {} } };
        if (call === 1) return { kind: "tool-info", request: { type: "history-entry", index: 0 } };
        return { kind: "done" };
      };
    })());
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "entry-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "get the full entry", agentName: "entry-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // The third reasoner call saw the full untruncated entry.
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    const infoResult = inputs[2]?.toolInfoResult;
    expect(infoResult).toBeDefined();
    expect(infoResult).toMatch(/toolHistoryEntry/);
    // Full output is present (1000 chars of x), not the 500-char truncated version.
    expect(infoResult).toMatch(/x{1000}/);
  });
});

describe("tool history appears in the reasoner user message", () => {
  it("the next reasoner call sees prior tool history in its input", async () => {
    const store = createInMemoryStore();
    const tool = {
      name: "echo",
      description: "echo",
      schema: z.object({ message: z.string() }),
      fn: async ({ data }: { data: unknown }) => Ok({ echoed: (data as { message: string }).message }),
    };
    const { reasoner, inputs } = captureReasoner((() => {
      let i = 0;
      return async () => {
        const call = i++;
        if (call === 0) return { kind: "tool", toolCall: { toolName: "echo", input: { message: "ping" } } };
        return { kind: "done" };
      };
    })());
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "msgs-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    await delta.send({ goal: "tool then inspect", agentName: "msgs-agent" });
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    const second = inputs[1];
    expect(second?.toolHistory).toBeDefined();
    expect(second?.toolHistory).toHaveLength(1);
    expect(second?.toolHistory?.[0]?.toolName).toBe("echo");
  });
});

describe("token stamping on tool history entries", () => {
  it("stamps a token count estimate on every entry", async () => {
    const store = createInMemoryStore();
    const tool = {
      name: "echo",
      description: "echo",
      schema: z.object({ message: z.string() }),
      fn: async ({ data }: { data: unknown }) => Ok({ echoed: (data as { message: string }).message }),
    };
    const { reasoner } = captureReasoner((() => {
      let i = 0;
      return async () => {
        i++;
        if (i === 1) return { kind: "tool", toolCall: { toolName: "echo", input: { message: "size" } } };
        return { kind: "done" };
      };
    })());
    const delta = await createDeltaEngine({ store, reasoner, tools: { custom: [tool] } });
    delta.deploy(delta.agent({ name: "tk-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "token", agentName: "tk-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    const entry = result.value.snapshot.toolHistory?.[0];
    expect(entry?.tokenCount).toBeDefined();
    // 4 chars per token heuristic — at least 1.
    expect(entry?.tokenCount).toBeGreaterThanOrEqual(1);
  });
});
