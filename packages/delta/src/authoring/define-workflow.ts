/**
 * delta.workflow({ ... }) — define an ordered procedure.
 *
 * Validates and registers the workflow definition. The phases inside the
 * workflow must already exist in the registry (created via delta.phase).
 *
 * Throws on validation or registration failure — a bad workflow definition
 * is a programming error.
 */

import type { Workflow } from "./types";
import type { Registry } from "./registry";
import { validateWorkflow } from "./validate";

export const makeDefineWorkflow = ({ registry }: { registry: Registry }) =>
  (definition: Workflow): Workflow => {
    const validation = validateWorkflow(definition);
    if (validation.isErr) {
      throw new Error(`delta.workflow validation failed: ${validation.error}`);
    }

    const result = registry.registerWorkflow(definition);
    if (result.isErr) {
      throw new Error(`delta.workflow registration failed: ${result.error}`);
    }

    return definition;
  };
