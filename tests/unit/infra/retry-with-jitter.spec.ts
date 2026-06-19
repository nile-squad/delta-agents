import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Ok, Err } from "slang-ts";
import { retryWithJitter, computeBackoff } from "../../../src/infra";

describe("retryWithJitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Ok immediately on first success without retrying", async () => {
    let callCount = 0;
    const promise = retryWithJitter({
      fn: async () => {
        callCount++;
        return Ok("success");
      },
      options: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitterFactor: 0 },
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBe("success");
    expect(callCount).toBe(1);
  });

  it("retries on Err and returns Ok on second attempt", async () => {
    let callCount = 0;
    const promise = retryWithJitter({
      fn: async () => {
        callCount++;
        return callCount === 1 ? Err("first attempt failed") : Ok("recovered");
      },
      options: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterFactor: 0 },
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBe("recovered");
    expect(callCount).toBe(2);
  });

  it("returns Err with last error message after exhausting maxAttempts", async () => {
    let callCount = 0;
    const promise = retryWithJitter({
      fn: async () => {
        callCount++;
        return Err(`attempt ${callCount} failed`);
      },
      options: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterFactor: 0 },
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toBe("attempt 3 failed");
    expect(callCount).toBe(3);
  });

  it("does not retry on success even with attempts remaining", async () => {
    let callCount = 0;
    const promise = retryWithJitter({
      fn: async () => {
        callCount++;
        return Ok(42);
      },
      options: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, jitterFactor: 0 },
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(callCount).toBe(1);
  });
});

describe("computeBackoff", () => {
  it("doubles the base delay on each attempt (exponential)", () => {
    // With jitterFactor 0, delay is deterministic
    const opts = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, jitterFactor: 0 };
    expect(computeBackoff(1, opts)).toBe(100); // 100 * 2^0
    expect(computeBackoff(2, opts)).toBe(200); // 100 * 2^1
    expect(computeBackoff(3, opts)).toBe(400); // 100 * 2^2
  });

  it("caps delay at maxDelayMs", () => {
    const opts = { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 500, jitterFactor: 0 };
    expect(computeBackoff(1, opts)).toBe(500);
    expect(computeBackoff(5, opts)).toBe(500);
  });

  it("jitter makes consecutive delays different from one another", () => {
    // With jitter enabled, two calls with the same attempt number should not
    // produce exactly the same value. We run 20 trials to make a collision
    // astronomically unlikely.
    const opts = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, jitterFactor: 0.5 };
    const delays = Array.from({ length: 20 }, () => computeBackoff(1, opts));
    const unique = new Set(delays);
    // With 20 random samples from a continuous range, all are almost certainly unique
    expect(unique.size).toBeGreaterThan(1);
  });

  it("jitter never makes delay negative", () => {
    const opts = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, jitterFactor: 1 };
    for (let i = 0; i < 50; i++) {
      expect(computeBackoff(1, opts)).toBeGreaterThanOrEqual(100);
    }
  });

  it("zero jitterFactor produces the same delay every call", () => {
    const opts = { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 10_000, jitterFactor: 0 };
    const delays = Array.from({ length: 10 }, () => computeBackoff(2, opts));
    expect(new Set(delays).size).toBe(1);
  });
});
