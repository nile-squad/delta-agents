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

import { Ok, Err, option } from "slang-ts";
import type { Result } from "slang-ts";
import type { HookFn, ActionContext } from "../authoring/types";

/**
 * Run a single hook, catching thrown exceptions separately from returned Err.
 * Returns Ok(void) when the hook is absent or succeeds.
 * Returns Err(message) if the hook throws or returns its own Err.
 *
 * Note: we use a manual try-catch rather than safeTry because safeTry
 * evaluates Result return values — it would unwrap the hook's Result and lose
 * the isOk/isErr distinction we need to surface the correct error prefix.
 */
export const runHook = async (
  hook: HookFn | undefined,
  ctx: ActionContext,
): Promise<Result<void, string>> => {
  const hookOpt = option(hook);
  if (hookOpt.isNone) return Ok(undefined);

  let result: Result<unknown, string>;
  try {
    result = await hookOpt.value(ctx);
  } catch (e) {
    return Err(`hook threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (result.isErr) return Err(`hook returned Err: ${result.error}`);
  return Ok(undefined);
};
