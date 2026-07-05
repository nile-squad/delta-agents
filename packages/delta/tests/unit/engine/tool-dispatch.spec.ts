/**
 * tool-dispatch tests — ToolContext assembly.
 *
 * handleToolExecution builds the TaskID-attributable ToolContext a tool fn runs
 * against. These tests verify the goal is threaded onto that context when the
 * caller supplies it, and omitted otherwise.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { handleToolExecution } from "../../../src/engine/tool-dispatch";
import { createLoopDetector } from "../../../src/engine/loop-detector";
import { createRegistry } from "../../../src/authoring/registry";
import { createEngineLogger } from "../../../src/shared/logger";
import { initialTrust, initialRiskState } from "../../../src/governance";
import type { Agent, Tool, ToolContext } from "../../../src/authoring";
import type { Task } from "../../../src/shared/types";
import type { TaskStateSnapshot } from "../../../src/state-space";

const silentLogger = createEngineLogger({ drain: { type: "custom", write: () => {} } });

const agent: Agent = {
  name: "test-agent",
  description: "agent",
  role: "tester",
  rolePrompt: "test",
  actions: [],
};

const makeTask = (goal: string): Task => ({
  id: "tsk_tool",
  rootId: "tsk_tool",
  status: "running",
  goal,
  assignedAgent: "test-agent",
  budget: { tokens: 10_000, durationMs: 60_000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const snapshot: TaskStateSnapshot = {
  taskId: "tsk_tool",
  rootId: "tsk_tool",
  agentName: "test-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 10_000, durationMs: 60_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: initialRiskState(),
  trust: initialTrust(),
};

const registryWithCapturingTool = (): { registry: ReturnType<typeof createRegistry>; seen: () => ToolContext | undefined } => {
  let captured: ToolContext | undefined;
  const tool: Tool = {
    name: "probe",
    description: "captures its ctx",
    schema: z.object({}),
    fn: async ({ ctx }) => { captured = ctx; return Ok("ok"); },
  };
  const registry = createRegistry();
  registry.registerTool(tool);
  return { registry, seen: () => captured };
};

describe("handleToolExecution — ToolContext.goal", () => {
  it("threads the goal onto the tool's ctx when supplied", async () => {
    const { registry, seen } = registryWithCapturingTool();
    await handleToolExecution({
      decision: { kind: "tool", toolCall: { toolName: "probe", input: {} } },
      agent,
      task: makeTask("ship the release"),
      snapshot,
      registry,
      loopDetector: createLoopDetector({ logger: silentLogger }),
      goal: "ship the release",
    });
    expect(seen()?.goal).toBe("ship the release");
  });

  it("omits goal from the tool's ctx when not supplied", async () => {
    const { registry, seen } = registryWithCapturingTool();
    await handleToolExecution({
      decision: { kind: "tool", toolCall: { toolName: "probe", input: {} } },
      agent,
      task: makeTask("ship the release"),
      snapshot,
      registry,
      loopDetector: createLoopDetector({ logger: silentLogger }),
    });
    expect(seen()?.goal).toBeUndefined();
  });
});
