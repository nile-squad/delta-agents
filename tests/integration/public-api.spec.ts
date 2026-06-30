/**
 * Public API smoke test.
 *
 * Imports only from "../../src" (the package entry point) and exercises the
 * complete authoring + runtime surface to prove the public surface is wired.
 * No internal module paths — if a name is not reachable from src/index.ts it
 * is not part of the public API and should not be tested here.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  // Engine factory and runtime types
  createDeltaEngine,
  // Adapters
  createInMemoryStore,
  createMockReasoner,
  // Result utilities re-exported from slang-ts
  Ok,
  Err,
} from "../../src";

// Type imports — prove they are reachable from the public entry point.
// If any of these were missing from src/index.ts the compiler would reject
// this file at build time, so this serves as a compile-time surface check.
import type {
  DeltaEngine,
  DeltaEngineConfig,
  SendInput,
  SendResult,
  InspectResult,
  Agent,
  Workflow,
  Phase,
  Channel,
  ChannelType,
  ActionContext,
  Cost,
  Task,
  SupervisionPolicy,
  Memory,
  ModelDef,
  ModelOptions,
} from "../../src";

describe("public-api — smoke test", () => {
  it("constructs an engine and drives a task to completion", async () => {
    const store = createInMemoryStore();
    const reasoner = createMockReasoner({
      responses: [{ actionName: "greet", input: { name: "world" } }],
    });

    // createDeltaEngine is the single entry point.
    const delta = await createDeltaEngine({ store, reasoner });

    // Authoring — define an action. delta.action() infers TInput from the Zod
    // schema; the fn receives the inferred narrowed type. We do not annotate
    // the variable type to avoid fighting the fn-contravariance issue that
    // exists when assigning Action<TSpecific> to Action<Record<string,unknown>>.
    const greet = delta.action({
      name: "greet",
      description: "Greet a user by name",
      schema: z.object({ name: z.string() }),
      fn: async ({ name }) => Ok(`Hello, ${name}!`),
    });

    // delta.agent validates and registers the agent.
    const assistant = delta.agent({
      name: "assistant",
      description: "A simple assistant",
      role: "Assistant",
      rolePrompt: "Help the user.",
      actions: [greet],
    });

    // Runtime — deploy, send a goal, inspect the result.
    delta.deploy(assistant);

    const sendInput: SendInput = { goal: "greet the user", agentName: "assistant" };
    const result = await delta.send(sendInput);

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      const sendResult: SendResult = result.value;
      expect(sendResult.status).toBe("completed");
      expect(sendResult.taskId).toBeDefined();

      const inspected = await delta.inspect(sendResult.taskId);
      expect(inspected.isOk).toBe(true);
      if (inspected.isOk) {
        const inspectResult: InspectResult = inspected.value;
        const task: Task = inspectResult.task;
        expect(task.assignedAgent).toBe("assistant");
        expect(inspectResult.executions.length).toBeGreaterThan(0);
      }
    }
  });

  it("re-exports Ok and Err from slang-ts", () => {
    expect(Ok(42).isOk).toBe(true);
    expect(Err("fail").isErr).toBe(true);
  });

  it("exports a working createMockReasoner adapter", () => {
    const reasoner = createMockReasoner({ responses: [] });
    expect(typeof reasoner.reason).toBe("function");
  });

  it("exports a working createInMemoryStore adapter", () => {
    const store = createInMemoryStore();
    // Verify key StoragePort methods are present.
    expect(typeof store.saveTask).toBe("function");
    expect(typeof store.getTask).toBe("function");
  });

  // Type-level assertions: the types below are imported from "../../src".
  // If any were missing from the public surface the compiler rejects this file.
  it("type imports from public entry compile correctly", () => {
    // Narrow a Cost value to confirm the type is accessible at runtime.
    const cost: Cost = { tokens: 10, durationMs: 50 };
    expect(cost.tokens).toBe(10);

    // Confirm ChannelType is a usable string literal union value.
    const channelType: ChannelType = "slack";
    expect(channelType).toBe("slack");

    // Confirm SupervisionPolicy structure.
    const policy: SupervisionPolicy = { strategy: "retry", maxRetries: 3 };
    expect(policy.strategy).toBe("retry");

    // Confirm DeltaEngineConfig, Agent, Workflow, Phase, Channel, ActionContext,
    // InspectResult, SendResult, Memory, Task are all accessible.
    // We reference them in assignments so the compiler checks them.
    const _config: DeltaEngineConfig = {};
    const _agent: Agent = {
      name: "x",
      description: "x",
      role: "x",
      rolePrompt: "x",
      actions: [],
    };
    const _phase: Phase = { name: "p", description: "d", actions: [], checkpoint: false };
    const _workflow: Workflow = {
      name: "w",
      description: "d",
      version: "1",
      phases: [_phase],
    };
    expect(_config).toBeDefined();
    expect(_agent.name).toBe("x");
    expect(_workflow.version).toBe("1");

    // Confirm ModelDef and ModelOptions are reachable from the public entry point.
    const _modelDef: ModelDef = { name: "fast", model: "gpt-4o-mini", default: true };
    const _modelOptions: ModelOptions = { temperature: 0.7 };
    expect(_modelDef.name).toBe("fast");
    expect(_modelOptions.temperature).toBe(0.7);
  });

  // ── models DX — construction-time validation ──────────────────────────────

  it("createDeltaEngine throws when models is non-empty but no model has default: true", async () => {
    await expect(
      createDeltaEngine({
        models: [
          { name: "alpha", model: "gpt-4o-mini" },
          { name: "beta", model: "gpt-4o" },
        ],
      }),
    ).rejects.toThrow(
      "createDeltaEngine: no default model — exactly one model must have default: true",
    );
  });

  it("createDeltaEngine throws when two models share the same name", async () => {
    await expect(
      createDeltaEngine({
        models: [
          { name: "alpha", model: "gpt-4o-mini", default: true },
          { name: "alpha", model: "gpt-4o" },
        ],
      }),
    ).rejects.toThrow("createDeltaEngine: duplicate model names: alpha");
  });

  it("createDeltaEngine throws when two models both have default: true", async () => {
    await expect(
      createDeltaEngine({
        models: [
          { name: "alpha", model: "gpt-4o-mini", default: true },
          { name: "beta", model: "gpt-4o", default: true },
        ],
      }),
    ).rejects.toThrow(
      "createDeltaEngine: multiple default models (alpha, beta) — exactly one must have default: true",
    );
  });

  // ── models DX — agent authoring validation ────────────────────────────────

  it("delta.agent throws when the model name is not in models", async () => {
    const delta = await createDeltaEngine({
      models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
    });
    // Model check fires before validateAgent, so actions need not be non-empty for
    // the error to trigger — but we pass a valid action for completeness.
    const ping = delta.action({
      name: "ping",
      description: "ping action",
      schema: z.object({ target: z.string() }),
      fn: async () => Ok("pong"),
    });
    expect(() =>
      delta.agent({
        name: "bad-model-agent",
        description: "agent with unknown model",
        role: "tester",
        rolePrompt: "run tests",
        actions: [ping],
        model: "nonexistent",
      }),
    ).toThrow(
      'delta.agent: model "nonexistent" is not defined — available models: fast',
    );
  });

  it("delta.agent does not throw when the model name exists in models", async () => {
    const delta = await createDeltaEngine({
      models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
    });
    const pong = delta.action({
      name: "pong",
      description: "pong action",
      schema: z.object({ target: z.string() }),
      fn: async () => Ok("pong"),
    });
    expect(() =>
      delta.agent({
        name: "good-model-agent",
        description: "agent with known model",
        role: "tester",
        rolePrompt: "run tests",
        actions: [pong],
        model: "fast",
      }),
    ).not.toThrow();
  });
});
