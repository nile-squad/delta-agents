/**
 * delta.tool({ ... }) — define a reusable, stateless utility.
 *
 * Validates the definition at call time and registers it so the engine
 * can discover it globally. Returns the validated Tool so callers can
 * reference it in agent or phase tool hints.
 *
 * Throws on validation failure because an invalid definition is a programming
 * error, not a recoverable runtime condition — catching it would silently
 * produce a broken agent (AGENTS.md: "Critical harm → throw fast").
 */

import type { Tool } from "./types";
import type { Registry } from "./registry";
import { validateTool } from "./validate";

export const makeDefineTool = ({ registry }: { registry: Registry }) =>
  (definition: Tool): Tool => {
    const validation = validateTool(definition);
    if (validation.isErr) {
      throw new Error(`delta.tool validation failed: ${validation.error}`);
    }

    const result = registry.registerTool(definition);
    if (result.isErr) {
      throw new Error(`delta.tool registration failed: ${result.error}`);
    }

    return definition;
  };
