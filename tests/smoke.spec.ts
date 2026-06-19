/**
 * Smoke test: verifies the project entry point re-exports slang-ts utilities.
 * The implementing agent will replace this with real delta-agents tests.
 */
import { describe, expect, it } from "vitest";
import { Err, Ok, option, match, safeTry, pipe } from "../index";

describe("entry point smoke test", () => {
  it("re-exports Ok and Err from slang-ts", () => {
    expect(Ok(1).isOk).toBe(true);
    expect(Err("fail").isErr).toBe(true);
  });

  it("re-exports option from slang-ts", () => {
    expect(option(1).isSome).toBe(true);
    expect(option(null).isNone).toBe(true);
  });

  it("re-exports match from slang-ts", () => {
    const output = match(Ok(42), {
      Ok: (v) => `success: ${v.value}`,
      Err: (e) => `error: ${e.error}`,
    });
    expect(output).toBe("success: 42");
  });

  it("re-exports safeTry from slang-ts", async () => {
    const result = await safeTry(() => "ok");
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value).toBe("ok");
    }
  });

  it("re-exports pipe from slang-ts", async () => {
    const result = await pipe(
      5,
      (res) => (res.isOk ? Ok(res.value + 1) : res),
      (res) => (res.isOk ? Ok(res.value * 2) : res),
    ).run();
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value).toBe(12);
    }
  });
});
