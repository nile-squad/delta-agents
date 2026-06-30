import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateAgent } from "../../../src/authoring";
import type { Action, Agent, Workflow } from "../../../src/authoring";
import { Ok } from "slang-ts";

const schema = z.object({ id: z.string() });
const fn = async () => Ok("ok");

const makeAction = (name: string): Action => ({
  name,
  description: `Action ${name}`,
  schema,
  fn,
});

const makeWorkflow = (name: string): Workflow => ({
  name,
  description: `Workflow ${name}`,
  version: "1.0.0",
  phases: [
    {
      name: "phase-1",
      description: "First phase",
      actions: [],
      checkpoint: false,
    },
  ],
});

const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  name: "test-agent",
  description: "Test agent",
  role: "tester",
  rolePrompt: "You are a tester.",
  actions: [makeAction("a1")],
  ...overrides,
});

describe("validateAgent — prerequisite action name resolution", () => {
  it("accepts an agent whose actions reference registered prerequisite action names", () => {
    const knownActions = new Set(["a1", "a2"]);
    const knownWorkflows = new Set<string>();
    const agent = makeAgent({
      actions: [
        { ...makeAction("a1"), prerequisites: { actions: ["a2"] } },
        makeAction("a2"),
      ],
    });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isOk).toBe(true);
  });

  it("rejects when a prerequisite action name is not registered", () => {
    const knownActions = new Set(["a1"]);
    const knownWorkflows = new Set<string>();
    const agent = makeAgent({
      actions: [
        { ...makeAction("a1"), prerequisites: { actions: ["confirm-orer"] } },
      ],
    });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isErr).toBe(true);
    if (result.isErr) {
      expect(result.error).toMatch(/prerequisite action "confirm-orer"/);
      expect(result.error).toMatch(/is not registered/);
      expect(result.error).toMatch(/action "a1"/);
    }
  });
});

describe("validateAgent — prerequisite workflow name resolution", () => {
  it("accepts an agent whose actions reference registered prerequisite workflow names", () => {
    const knownActions = new Set(["a1"]);
    const knownWorkflows = new Set(["wf-1"]);
    const agent = makeAgent({
      actions: [
        { ...makeAction("a1"), prerequisites: { workflows: ["wf-1"] } },
      ],
    });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isOk).toBe(true);
  });

  it("rejects when a prerequisite workflow name is not registered", () => {
    const knownActions = new Set(["a1"]);
    const knownWorkflows = new Set<string>();
    const agent = makeAgent({
      actions: [
        { ...makeAction("a1"), prerequisites: { workflows: ["fraud-review"] } },
      ],
    });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isErr).toBe(true);
    if (result.isErr) {
      expect(result.error).toMatch(/prerequisite workflow "fraud-review"/);
      expect(result.error).toMatch(/is not registered/);
      expect(result.error).toMatch(/action "a1"/);
    }
  });
});

describe("validateAgent — no regression on prerequisite-less agents", () => {
  it("accepts an agent whose actions have no prerequisites declared", () => {
    const knownActions = new Set(["a1"]);
    const knownWorkflows = new Set<string>();
    const agent = makeAgent({ actions: [makeAction("a1")] });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isOk).toBe(true);
  });

  it("accepts an agent whose actions declare empty prerequisite bags", () => {
    const knownActions = new Set(["a1"]);
    const knownWorkflows = new Set<string>();
    const agent = makeAgent({
      actions: [
        { ...makeAction("a1"), prerequisites: { actions: [], workflows: [] } },
      ],
    });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isOk).toBe(true);
  });
});

describe("validateAgent — mixed action + workflow prerequisites", () => {
  it("accepts when both action and workflow prerequisites resolve to registered names", () => {
    const knownActions = new Set(["a1", "a2"]);
    const knownWorkflows = new Set(["wf-1"]);
    const agent = makeAgent({
      actions: [
        {
          ...makeAction("a1"),
          prerequisites: { actions: ["a2"], workflows: ["wf-1"] },
        },
        makeAction("a2"),
      ],
    });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isOk).toBe(true);
  });

  it("rejects with the action error first when both are unregistered", () => {
    const knownActions = new Set(["a1"]);
    const knownWorkflows = new Set<string>();
    const agent = makeAgent({
      actions: [
        {
          ...makeAction("a1"),
          prerequisites: { actions: ["missing-action"], workflows: ["missing-workflow"] },
        },
      ],
    });
    const result = validateAgent(agent, knownActions, knownWorkflows);
    expect(result.isErr).toBe(true);
    if (result.isErr) {
      expect(result.error).toMatch(/prerequisite action "missing-action"/);
      expect(result.error).toMatch(/is not registered/);
    }
  });
});
