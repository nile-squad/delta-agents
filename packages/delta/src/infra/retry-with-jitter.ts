/**
 * Retry with exponential backoff and random jitter.
 *
 * Jitter is mandatory (not optional) because multiple callers retrying on the
 * same schedule produce a thundering herd — a spike that can saturate downstream
 * systems and cause cascading failures. Random spread breaks the synchrony
 * (AGENTS.md: "a slight delay is better than a race condition").
 *
 * Used by the execution gateway, supervision strategies, and any infra code that
 * retries fallible I/O. Never write raw sleep + backoff — always use this.
 */

import { Err } from "slang-ts";
import type { Result } from "slang-ts";

export type RetryOptions = {
  /** Maximum number of attempts before returning the last Err. */
  maxAttempts: number;
  /** Base delay in ms before the first retry. Doubles each attempt. */
  baseDelayMs: number;
  /** Delay is capped at this value regardless of the exponent. */
  maxDelayMs: number;
  /**
   * Fraction of baseDelayMs added as random noise per attempt (0 to 1).
   * 0 = no jitter (dangerous under concurrent load).
   * 0.5 = ±50% of baseDelayMs randomised.
   */
  jitterFactor: number;
};

export const defaultRetryOptions: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  jitterFactor: 0.3,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const computeBackoff = (attempt: number, options: RetryOptions): number => {
  const exponential = options.baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = options.baseDelayMs * options.jitterFactor * Math.random();
  return Math.min(exponential + jitter, options.maxDelayMs);
};

/**
 * Retry `fn` up to `maxAttempts` times.
 * Returns the first Ok result, or Err with the last error after all attempts fail.
 */
export const retryWithJitter = async <T>({
  fn,
  options: partial,
}: {
  fn: () => Promise<Result<T, string>>;
  options?: Partial<RetryOptions>;
}): Promise<Result<T, string>> => {
  const options = { ...defaultRetryOptions, ...partial };
  let lastError = "exhausted retries with no error message";

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const result = await fn();
    if (result.isOk) return result;
    lastError = result.error;
    if (attempt < options.maxAttempts) {
      await sleep(computeBackoff(attempt, options));
    }
  }

  return Err(lastError);
};
