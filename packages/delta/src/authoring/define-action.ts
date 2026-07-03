/**
 * delta.action({ ... }) — define an executable operation.
 *
 * Validates the definition at call time and registers it so the execution
 * gateway can look it up by name. Returns the validated Action so callers
 * can pass it directly to delta.agent({ actions: [lookupCustomer, ...] }).
 *
 * Throws on validation failure because an invalid definition is a programming
 * error, not a recoverable runtime condition — catching it would silently
 * produce a broken agent (AGENTS.md: "Critical harm → throw fast").
 */

import type { Action } from "./types";
import type { Registry } from "./registry";
import { validateAction } from "./validate";

export const makeDefineAction = ({ registry }: { registry: Registry }) =>
  <TInput extends Record<string, unknown>>(definition: Action<TInput>): Action<TInput> => {
    const validation = validateAction(definition as Action);
    if (validation.isErr) {
      throw new Error(`delta.action validation failed: ${validation.error}`);
    }

    const result = registry.registerAction(definition as Action);
    if (result.isErr) {
      throw new Error(`delta.action registration failed: ${result.error}`);
    }

    return definition;
  };
