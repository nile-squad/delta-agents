/**
 * Tests for the define-* factory functions (delta.action, delta.workflow,
 * delta.phase, delta.agent). These are the developer-facing authoring surface.
 *
 * Key properties:
 * - Invalid definitions throw immediately (programming error, not runtime error)
 * - Duplicate names throw
 * - Valid definitions are returned so they can be passed to delta.agent
 * - delta.agent validates that referenced actions/workflows are already registered
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createRegistry,
  makeDefineAction,
  makeDefineWorkflow,
  makeDefineAgent,
} from "../../../src/authoring";
import { Ok } from "slang-ts";

const schema = z.object({ id: z.string() });
const fn = async () => Ok("ok");

const buildDelta = () => {
  const registry = createRegistry();
  return {
    registry,
    action: makeDefineAction({ registry }),
    workflow: makeDefineWorkflow({ registry }),
    agent: makeDefineAgent({ registry }),
  };
};

describe("delta.action", () => {
  it("registers a valid action and returns it", () => {
    const delta = buildDelta();
    const action = delta.action({ name: "lookup", description: "Look up record", schema, fn });
    expect(action.name).toBe("lookup");
    expect(delta.registry.getAction("lookup").isOk).toBe(true);
  });

  it("throws on missing schema (invariant 4)", () => {
    const delta = buildDelta();
    expect(() =>
      delta.action({ name: "bad", description: "No schema", schema: undefined as never, fn }),
    ).toThrow(/schema is required/);
  });

  it("throws on empty name", () => {
    const delta = buildDelta();
    expect(() =>
      delta.action({ name: "", description: "No name", schema, fn }),
    ).toThrow();
  });

  it("throws on duplicate action name", () => {
    const delta = buildDelta();
    delta.action({ name: "lookup", description: "First", schema, fn });
    expect(() =>
      delta.action({ name: "lookup", description: "Duplicate", schema, fn }),
    ).toThrow(/already registered/);
  });

  it("preserves optional risk and estimatedCost as priors unchanged", () => {
    const delta = buildDelta();
    const action = delta.action({
      name: "risky-op",
      description: "High risk operation",
      schema,
      fn,
      risk: 4,
      estimatedCost: { tokens: 1000, durationMs: 5000 },
    });
    expect(action.risk).toBe(4);
    expect(action.estimatedCost).toEqual({ tokens: 1000, durationMs: 5000 });
  });

  it("accepts action without risk or estimatedCost", () => {
    const delta = buildDelta();
    const action = delta.action({ name: "safe-read", description: "Safe read", schema, fn });
    expect(action.risk).toBeUndefined();
    expect(action.estimatedCost).toBeUndefined();
  });
});

describe("delta.workflow", () => {
  it("registers a valid workflow and returns it", () => {
    const delta = buildDelta();
    const ph = {
      name: "investigation",
      description: "Look up customer",
      actions: ["lookup-customer"],
      checkpoint: true,
    };
    const wf = delta.workflow({
      name: "customer-support",
      description: "Customer support workflow",
      version: "1.0.0",
      phases: [ph],
    });
    expect(wf.name).toBe("customer-support");
    expect(delta.registry.getWorkflow("customer-support").isOk).toBe(true);
  });

  it("throws on empty phases list", () => {
    const delta = buildDelta();
    expect(() =>
      delta.workflow({ name: "empty-wf", description: "Empty", version: "1.0.0", phases: [] }),
    ).toThrow(/non-empty/);
  });

  it("throws on duplicate workflow name", () => {
    const delta = buildDelta();
    const ph = { name: "ph", description: "Phase", actions: ["a"], checkpoint: false };
    const wfDef = { name: "wf", description: "Wf", version: "1.0.0", phases: [ph] };
    delta.workflow(wfDef);
    expect(() => delta.workflow(wfDef)).toThrow(/already registered/);
  });

  it("throws when a phase has an empty actions list", () => {
    const delta = buildDelta();
    expect(() =>
      delta.workflow({
        name: "empty-actions-wf",
        description: "has a phase with no actions",
        version: "1.0.0",
        phases: [{ name: "p", description: "d", actions: [], checkpoint: false }],
      }),
    ).toThrow(/non-empty/);
  });

  it("throws when a branch target is not in the phase's action list", () => {
    const delta = buildDelta();
    expect(() =>
      delta.workflow({
        name: "bad-branch-wf",
        description: "has a bad branch",
        version: "1.0.0",
        phases: [
          {
            name: "p",
            description: "d",
            checkpoint: false,
            actions: [{ action: "step-a", onSuccess: "ghost-step" }],
          },
        ],
      }),
    ).toThrow(/"ghost-step" is not declared/);
  });
});

describe("delta.agent", () => {
  it("registers a valid agent and returns it", () => {
    const delta = buildDelta();
    const action = delta.action({ name: "lookup", description: "Lookup", schema, fn });
    const agent = delta.agent({
      name: "support-agent",
      description: "Customer support specialist",
      role: "Customer Support",
      rolePrompt: "You help customers resolve issues.",
      actions: [action],
    });
    expect(agent.name).toBe("support-agent");
    expect(delta.registry.getAgent("support-agent").isOk).toBe(true);
  });

  it("throws when actions list is empty", () => {
    const delta = buildDelta();
    expect(() =>
      delta.agent({
        name: "empty-agent",
        description: "No actions",
        role: "Role",
        rolePrompt: "Prompt",
        actions: [],
      }),
    ).toThrow(/non-empty/);
  });

  it("throws when a referenced action was not registered first", () => {
    const delta = buildDelta();
    // Deliberately NOT calling delta.action first
    const unregistered = { name: "ghost-action", description: "Ghost", schema, fn };
    expect(() =>
      delta.agent({
        name: "bad-agent",
        description: "Unregistered action",
        role: "Role",
        rolePrompt: "Prompt",
        actions: [unregistered],
      }),
    ).toThrow(/ghost-action.*must be registered/);
  });

  it("throws when a referenced workflow was not registered first", () => {
    const delta = buildDelta();
    const action = delta.action({ name: "lookup", description: "Lookup", schema, fn });
    const unregisteredWf = {
      name: "ghost-workflow",
      description: "Ghost",
      version: "1.0.0",
      phases: [],
    };
    expect(() =>
      delta.agent({
        name: "bad-agent",
        description: "Unregistered workflow",
        role: "Role",
        rolePrompt: "Prompt",
        actions: [action],
        workflows: [unregisteredWf],
      }),
    ).toThrow(/ghost-workflow.*must be registered/);
  });

  it("throws on duplicate agent name", () => {
    const delta = buildDelta();
    const action = delta.action({ name: "act", description: "Act", schema, fn });
    const agentDef = {
      name: "agent-x",
      description: "Agent",
      role: "Role",
      rolePrompt: "Prompt",
      actions: [action],
    };
    delta.agent(agentDef);
    expect(() => delta.agent(agentDef)).toThrow(/already registered/);
  });
});
