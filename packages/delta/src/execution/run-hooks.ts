/**
 * Hook runner — isolates hook execution from the gateway pipeline.
 *
 * Hooks observe and prepare. They never authorize actions, bypass schema
 * validation, risk checks, budget checks, approval checks, or prerequisites
 * (spec §Lifecycle Hooks, invariant 22, prohibition 17).
 *
 * A hook that returns Err or throws does not grant or deny governance authority —
 * it reports a setup failure. The gateway treats such failures as a signal that
 * preconditions for safe execution weren't met, but the hook itself made no
 * governance decision.
 */

import { Ok, Err, option, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import type { ActionContext } from "../authoring/types";

/**
 * Run a single hook, catching thrown exceptions and returned Err alike.
 * Returns Ok(void) when the hook is absent or succeeds.
 * Returns Err(message) if the hook throws or returns its own Err.
 *
 * Generic over the context type so callers can pass an extended ActionContext
 * (e.g. after-hooks receive `{ ...ctx, result }`, onError receives
 * `{ ...ctx, error }`) without widening or casting.
 */
export const runHook = async <C extends ActionContext>(
  hook: ((ctx: C) => Promise<Result<unknown, string>>) | undefined,
  ctx: C,
): Promise<Result<void, string>> => {
  const hookOpt = option(hook);
  if (hookOpt.isNone) return Ok(undefined);

  const result = await safeTry(async () => hookOpt.value(ctx));
  return result.isErr ? Err(`hook failed: ${result.error}`) : Ok(undefined);
};
