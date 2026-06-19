/**
 * delta.phase({ ... }) — define a workflow stage.
 *
 * Validates the phase definition (non-empty actions, branch targets resolve
 * to declared actions in the same phase) and registers it.
 *
 * Throws on validation or registration failure — a bad phase definition is a
 * programming error.
 */

import type { Phase } from "./types";
import type { Registry } from "./registry";
import { validatePhase } from "./validate";

export const makeDefinePhase = ({ registry }: { registry: Registry }) =>
  (definition: Phase): Phase => {
    const validation = validatePhase(definition);
    if (validation.isErr) {
      throw new Error(`delta.phase validation failed: ${validation.error}`);
    }

    const result = registry.registerPhase(definition);
    if (result.isErr) {
      throw new Error(`delta.phase registration failed: ${result.error}`);
    }

    return definition;
  };
