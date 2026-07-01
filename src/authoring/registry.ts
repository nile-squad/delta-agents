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

import type { Action, Workflow, Agent, DataSource, Tool } from "./types";
import { Err, Ok, option } from "slang-ts";
import type { Result } from "slang-ts";

export type Registry = {
  // Registration (called by define-* factories)
  registerAction: (action: Action) => Result<Action, string>;
  registerWorkflow: (workflow: Workflow) => Result<Workflow, string>;
  registerAgent: (agent: Agent) => Result<Agent, string>;
  registerDataSource: (dataSource: DataSource) => Result<DataSource, string>;
  registerTool: (tool: Tool) => Result<Tool, string>;

  /**
   * Mark an agent as deployed so send() may accept tasks for it.
   * WHY: delta.deploy() is the DX signal that authoring is complete; this
   * separates "defined" (registered) from "ready for execution" (deployed).
   * Returns Err when the agent is not even registered (must call delta.agent() first).
   */
  deployAgent: (agentName: string) => Result<void, string>;

  /**
   * Returns true iff the agent has been explicitly deployed.
   * Used by send() to gate task creation (L1).
   */
  isDeployed: (agentName: string) => boolean;

  // Lookup (called by engine at runtime)
  getAction: (name: string) => Result<Action, string>;
  getWorkflow: (name: string) => Result<Workflow, string>;
  getAgent: (name: string) => Result<Agent, string>;
  getDataSource: (name: string) => Result<DataSource, string>;
  getTool: (name: string) => Result<Tool, string>;

  // Discovery (used by state-space module)
  getActionsForAgent: (agentName: string) => Result<Action[], string>;
  getWorkflowsForAgent: (agentName: string) => Result<Workflow[], string>;

  /**
   * Names of the agent's teammates: other registered agents that share its
   * non-empty `team`. An agent with no team has every other registered agent as
   * an available peer (teams are opt-in scoping, not mandatory). Used to scope
   * delegation and mentions so an agent only collaborates within its team.
   */
  getTeammates: (agentName: string) => string[];

  // Inspection (used by tests and diagnostics)
  listActions: () => string[];
  listWorkflows: () => string[];
  listAgents: () => string[];
  listDataSources: () => string[];
  listTools: () => string[];
};

/**
 * Creates an isolated registry instance.
 * Each createDeltaEngine call gets its own registry so multiple engine
 * instances never share definitions.
 */
export const createRegistry = (): Registry => {
  const actions = new Map<string, Action>();
  const workflows = new Map<string, Workflow>();
  const agents = new Map<string, Agent>();
  const dataSources = new Map<string, DataSource>();
  const tools = new Map<string, Tool>();
  /**
   * Tracks agents that have been explicitly deployed via delta.deploy().
   * An agent that is defined (registered) but not deployed must not accept
   * tasks — deploy() is the DX signal that authoring is complete and the
   * agent is ready for execution (L1 gate: send rejects undefined-but-undeployed).
   */
  const deployed = new Set<string>();

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

    registerAgent: (agent) => {
      if (agents.has(agent.name)) {
        return Err(`agent "${agent.name}" is already registered`);
      }
      agents.set(agent.name, agent);
      return Ok(agent);
    },

    registerDataSource: (dataSource) => {
      if (dataSources.has(dataSource.name)) {
        return Err(`data source "${dataSource.name}" is already registered`);
      }
      dataSources.set(dataSource.name, dataSource);
      return Ok(dataSource);
    },

    registerTool: (tool) => {
      if (tools.has(tool.name)) {
        return Err(`tool "${tool.name}" is already registered`);
      }
      tools.set(tool.name, tool);
      return Ok(tool);
    },

    getAction: (name) => {
      const opt = option(actions.get(name));
      return opt.isSome ? Ok(opt.value) : Err(`action "${name}" not found in registry`);
    },

    getWorkflow: (name) => {
      const opt = option(workflows.get(name));
      return opt.isSome ? Ok(opt.value) : Err(`workflow "${name}" not found in registry`);
    },

    getAgent: (name) => {
      const opt = option(agents.get(name));
      return opt.isSome ? Ok(opt.value) : Err(`agent "${name}" not found in registry`);
    },

    getDataSource: (name) => {
      const opt = option(dataSources.get(name));
      return opt.isSome ? Ok(opt.value) : Err(`data source "${name}" not found in registry`);
    },

    getTool: (name) => {
      const opt = option(tools.get(name));
      return opt.isSome ? Ok(opt.value) : Err(`tool "${name}" not found in registry`);
    },

    deployAgent: (agentName) => {
      if (!agents.has(agentName)) {
        return Err(`agent "${agentName}" is not registered — call delta.agent() first`);
      }
      deployed.add(agentName);
      return Ok(undefined);
    },

    isDeployed: (agentName) => deployed.has(agentName),

    getActionsForAgent: (agentName) => {
      const opt = option(agents.get(agentName));
      if (opt.isNone) return Err(`agent "${agentName}" not found in registry`);
      return Ok(opt.value.actions);
    },

    getWorkflowsForAgent: (agentName) => {
      const opt = option(agents.get(agentName));
      if (opt.isNone) return Err(`agent "${agentName}" not found in registry`);
      return Ok(opt.value.workflows ?? []);
    },

    getTeammates: (agentName) => {
      const selfOpt = option(agents.get(agentName));
      const others = [...agents.values()].filter((a) => a.name !== agentName);
      // No team declared: every other agent is an available peer (opt-in scoping).
      if (selfOpt.isNone || option(selfOpt.value.team).isNone) return others.map((a) => a.name);
      // Team declared: only agents sharing the same team.
      return others.filter((a) => a.team === selfOpt.value.team).map((a) => a.name);
    },

    listActions: () => [...actions.keys()],
    listWorkflows: () => [...workflows.keys()],
    listAgents: () => [...agents.keys()],
    listDataSources: () => [...dataSources.keys()],
    listTools: () => [...tools.keys()],
  };
};
