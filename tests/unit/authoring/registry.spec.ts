import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createRegistry } from "../../../src/authoring";
import type { Action, Phase, Workflow, Agent } from "../../../src/authoring";
import { Ok } from "slang-ts";

const schema = z.object({ id: z.string() });
const fn = async () => Ok("ok");

const makeAction = (name: string): Action => ({
  name,
  description: `${name} action`,
  schema,
  fn,
});

const makePhase = (name: string): Phase => ({
  name,
  description: `${name} phase`,
  actions: ["lookup-customer"],
  checkpoint: true,
});

const makeWorkflow = (name: string, phases: Phase[]): Workflow => ({
  name,
  description: `${name} workflow`,
  version: "1.0.0",
  phases,
});

const makeAgent = (name: string, actions: Action[], workflows: Workflow[] = []): Agent => ({
  name,
  description: `${name} agent`,
  role: "Support Specialist",
  rolePrompt: "You help customers.",
  actions,
  workflows,
});

describe("Registry — actions", () => {
  it("registers and retrieves an action by name", () => {
    const registry = createRegistry();
    const action = makeAction("lookup-customer");
    registry.registerAction(action);
    const result = registry.getAction("lookup-customer");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.name).toBe("lookup-customer");
  });

  it("returns Err when action not found", () => {
    const registry = createRegistry();
    const result = registry.getAction("ghost");
    expect(result.isErr).toBe(true);
  });

  it("rejects duplicate action names", () => {
    const registry = createRegistry();
    registry.registerAction(makeAction("lookup-customer"));
    const result = registry.registerAction(makeAction("lookup-customer"));
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/already registered/);
  });

  it("listActions returns all registered action names", () => {
    const registry = createRegistry();
    registry.registerAction(makeAction("action-a"));
    registry.registerAction(makeAction("action-b"));
    expect(registry.listActions()).toContain("action-a");
    expect(registry.listActions()).toContain("action-b");
  });
});

describe("Registry — workflows and phases", () => {
  it("registers and retrieves a workflow", () => {
    const registry = createRegistry();
    const wf = makeWorkflow("support-flow", [makePhase("investigation")]);
    registry.registerWorkflow(wf);
    const result = registry.getWorkflow("support-flow");
    expect(result.isOk).toBe(true);
  });

  it("rejects duplicate workflow names", () => {
    const registry = createRegistry();
    const wf = makeWorkflow("flow", [makePhase("ph")]);
    registry.registerWorkflow(wf);
    const result = registry.registerWorkflow(wf);
    expect(result.isErr).toBe(true);
  });

});

describe("Registry — agents", () => {
  it("registers and retrieves an agent by name", () => {
    const registry = createRegistry();
    const action = makeAction("lookup-customer");
    registry.registerAction(action);
    const agent = makeAgent("support-agent", [action]);
    registry.registerAgent(agent);
    const result = registry.getAgent("support-agent");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.name).toBe("support-agent");
  });

  it("rejects duplicate agent names", () => {
    const registry = createRegistry();
    const action = makeAction("lookup");
    registry.registerAction(action);
    const agent = makeAgent("agent-x", [action]);
    registry.registerAgent(agent);
    const result = registry.registerAgent(agent);
    expect(result.isErr).toBe(true);
  });

  it("getActionsForAgent returns the agent's registered actions", () => {
    const registry = createRegistry();
    const a1 = makeAction("action-one");
    const a2 = makeAction("action-two");
    registry.registerAction(a1);
    registry.registerAction(a2);
    registry.registerAgent(makeAgent("my-agent", [a1, a2]));
    const result = registry.getActionsForAgent("my-agent");
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.map((a) => a.name)).toEqual(["action-one", "action-two"]);
    }
  });

  it("getActionsForAgent returns Err for unknown agent", () => {
    const registry = createRegistry();
    const result = registry.getActionsForAgent("ghost-agent");
    expect(result.isErr).toBe(true);
  });

  it("getWorkflowsForAgent returns empty array when agent has no workflows", () => {
    const registry = createRegistry();
    const action = makeAction("do-thing");
    registry.registerAction(action);
    registry.registerAgent(makeAgent("minimal-agent", [action]));
    const result = registry.getWorkflowsForAgent("minimal-agent");
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toHaveLength(0);
  });
});

describe("Registry — isolation between instances", () => {
  it("two registry instances do not share state", () => {
    const r1 = createRegistry();
    const r2 = createRegistry();
    r1.registerAction(makeAction("shared-name"));
    expect(r2.getAction("shared-name").isErr).toBe(true);
  });
});
