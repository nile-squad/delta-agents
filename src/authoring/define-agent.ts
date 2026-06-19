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

import type { Agent } from "./types";
import type { Registry } from "./registry";
import { validateAgent } from "./validate";

export const makeDefineAgent = ({ registry }: { registry: Registry }) =>
  (definition: Agent): Agent => {
    const knownActionNames = new Set(registry.listActions());
    const knownWorkflowNames = new Set(registry.listWorkflows());

    const validation = validateAgent(definition, knownActionNames, knownWorkflowNames);
    if (validation.isErr) {
      throw new Error(`delta.agent validation failed: ${validation.error}`);
    }

    const result = registry.registerAgent(definition);
    if (result.isErr) {
      throw new Error(`delta.agent registration failed: ${result.error}`);
    }

    return definition;
  };
