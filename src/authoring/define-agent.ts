/**
 * delta.agent({ ... }) — define a role and its capabilities.
 *
 * Validates and registers the agent definition. All actions and workflows
 * referenced by the agent must already be registered (created via delta.action
 * and delta.workflow). This is enforced at definition time so a typo in an
 * action name fails loudly before any task is deployed.
 *
 * Throws on validation or registration failure — a bad agent definition is a
 * programming error.
 */

import type { Agent, Action } from "./types";
import { dataSourceActions } from "./types";
import type { Registry } from "./registry";
import { validateAgent } from "./validate";

/**
 * Merge the agent's declared actions with the operations of every attached
 * DataSource, de-duplicated by name. This is what makes a data operation
 * reachable: once it is in the agent's action set, discovery, the gateway, and
 * the workflow engine all govern it exactly like any other action, with no
 * special-casing downstream (ADR-007). An operation already listed directly in
 * `actions` is not duplicated.
 */
const expandActions = (definition: Agent): Action[] => {
  const byName = new Map<string, Action>();
  for (const action of definition.actions) byName.set(action.name, action);
  for (const dataSource of definition.dataSources ?? []) {
    for (const action of dataSourceActions(dataSource)) byName.set(action.name, action);
  }
  return [...byName.values()];
};

export const makeDefineAgent = ({ registry }: { registry: Registry }) =>
  (definition: Agent): Agent => {
    const knownActionNames = new Set(registry.listActions());
    const knownWorkflowNames = new Set(registry.listWorkflows());

    // Flatten DataSource operations into the agent's effective action set so the
    // rest of the engine sees one uniform action list (the data operations carry
    // the same governance as any action).
    const expanded: Agent = { ...definition, actions: expandActions(definition) };

    const validation = validateAgent(expanded, knownActionNames, knownWorkflowNames);
    if (validation.isErr) {
      throw new Error(`delta.agent validation failed: ${validation.error}`);
    }

    const result = registry.registerAgent(expanded);
    if (result.isErr) {
      throw new Error(`delta.agent registration failed: ${result.error}`);
    }

    return expanded;
  };
