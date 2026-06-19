/**
 * Authoring registry — the single source of truth for all defined actions,
 * workflows, phases, and agents.
 *
 * Every domain module (state-space, execution gateway, supervision) reads from
 * the registry. Nothing is looked up from user code at runtime — only from here.
 *
 * The registry is populated at authoring time (before deploy) and is read-only
 * during execution. This is what makes the action space bounded and inspectable
 * (spec §Bounded State-Space Model, principle 2).
 */

import type { Action, Workflow, Phase, Agent } from "./types";
import { Err, Ok } from "slang-ts";
import type { Result } from "slang-ts";

export type Registry = {
  // Registration (called by define-* factories)
  registerAction: (action: Action) => Result<Action, string>;
  registerWorkflow: (workflow: Workflow) => Result<Workflow, string>;
  registerPhase: (phase: Phase) => Result<Phase, string>;
  registerAgent: (agent: Agent) => Result<Agent, string>;

  // Lookup (called by engine at runtime)
  getAction: (name: string) => Result<Action, string>;
  getWorkflow: (name: string) => Result<Workflow, string>;
  getPhase: (name: string) => Result<Phase, string>;
  getAgent: (name: string) => Result<Agent, string>;

  // Discovery (used by state-space module)
  getActionsForAgent: (agentName: string) => Result<Action[], string>;
  getWorkflowsForAgent: (agentName: string) => Result<Workflow[], string>;

  // Inspection (used by tests and diagnostics)
  listActions: () => string[];
  listWorkflows: () => string[];
  listAgents: () => string[];
};

/**
 * Creates an isolated registry instance.
 * Each createDeltaEngine call gets its own registry so multiple engine
 * instances never share definitions.
 */
export const createRegistry = (): Registry => {
  const actions = new Map<string, Action>();
  const workflows = new Map<string, Workflow>();
  const phases = new Map<string, Phase>();
  const agents = new Map<string, Agent>();

  return {
    registerAction: (action) => {
      if (actions.has(action.name)) {
        return Err(`action "${action.name}" is already registered`);
      }
      actions.set(action.name, action);
      return Ok(action);
    },

    registerWorkflow: (workflow) => {
      if (workflows.has(workflow.name)) {
        return Err(`workflow "${workflow.name}" is already registered`);
      }
      workflows.set(workflow.name, workflow);
      return Ok(workflow);
    },

    registerPhase: (phase) => {
      if (phases.has(phase.name)) {
        return Err(`phase "${phase.name}" is already registered`);
      }
      phases.set(phase.name, phase);
      return Ok(phase);
    },

    registerAgent: (agent) => {
      if (agents.has(agent.name)) {
        return Err(`agent "${agent.name}" is already registered`);
      }
      agents.set(agent.name, agent);
      return Ok(agent);
    },

    getAction: (name) => {
      const action = actions.get(name);
      return action !== undefined ? Ok(action) : Err(`action "${name}" not found in registry`);
    },

    getWorkflow: (name) => {
      const workflow = workflows.get(name);
      return workflow !== undefined ? Ok(workflow) : Err(`workflow "${name}" not found in registry`);
    },

    getPhase: (name) => {
      const phase = phases.get(name);
      return phase !== undefined ? Ok(phase) : Err(`phase "${name}" not found in registry`);
    },

    getAgent: (name) => {
      const agent = agents.get(name);
      return agent !== undefined ? Ok(agent) : Err(`agent "${name}" not found in registry`);
    },

    getActionsForAgent: (agentName) => {
      const agent = agents.get(agentName);
      if (agent === undefined) return Err(`agent "${agentName}" not found in registry`);
      return Ok(agent.actions);
    },

    getWorkflowsForAgent: (agentName) => {
      const agent = agents.get(agentName);
      if (agent === undefined) return Err(`agent "${agentName}" not found in registry`);
      return Ok(agent.workflows ?? []);
    },

    listActions: () => [...actions.keys()],
    listWorkflows: () => [...workflows.keys()],
    listAgents: () => [...agents.keys()],
  };
};
