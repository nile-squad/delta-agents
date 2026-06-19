/**
 * Run-hooks tests.
 *
 * Hooks observe and prepare — they never authorize or bypass governance.
 * These tests verify runHook's isolation contract: it catches throws, flattens
 * the nested Result, and returns a clear Ok/Err to the gateway.
 *
 * Covers: invariant 22; prohibition 17.
 */

import { describe, it, expect } from "vitest";
import { Ok, Err } from "slang-ts";
import { runHook } from "../../../src/execution";
import type { ActionContext } from "../../../src/authoring";

const ctx: ActionContext = {
  taskId: "tsk_test",
  executionId: "exc_test",
  agentName: "test-agent",
};

describe("runHook — absent hook", () => {
  it("returns Ok when no hook is provided", async () => {
    const result = await runHook(undefined, ctx);
    expect(result.isOk).toBe(true);
  });
});

describe("runHook — successful hook", () => {
  it("returns Ok when hook returns Ok", async () => {
    const result = await runHook(async () => Ok("setup done"), ctx);
    expect(result.isOk).toBe(true);
  });

  it("passes the ActionContext into the hook", async () => {
    const received: ActionContext[] = [];
    await runHook(async (c) => { received.push(c); return Ok(undefined); }, ctx);
    expect(received[0]).toBe(ctx);
  });
});

describe("runHook — hook returns Err", () => {
  it("returns Err containing the hook's error message", async () => {
    const result = await runHook(async () => Err("setup failed"), ctx);
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toContain("setup failed");
  });

  it("result error is prefixed so the gateway can attribute the source", async () => {
    const result = await runHook(async () => Err("db unavailable"), ctx);
    if (result.isErr) expect(result.error).toMatch(/hook returned Err/);
  });
});

describe("runHook — hook throws", () => {
  it("returns Err when hook throws synchronously-resolved rejection", async () => {
    const result = await runHook(
      async () => { throw new Error("crash"); },
      ctx,
    );
    expect(result.isErr).toBe(true);
  });

  it("error is prefixed with 'hook threw' so the gateway can distinguish throws from Err returns", async () => {
    const result = await runHook(
      async () => { throw new Error("network timeout"); },
      ctx,
    );
    if (result.isErr) expect(result.error).toMatch(/hook threw/);
  });

  it("catching a throw does not grant the hook governance authority — result is just Err(message)", async () => {
    // A hook that throws cannot "approve" or "bypass" anything.
    // The gateway receives Err and decides what to do — the hook made no governance decision.
    const result = await runHook(
      async () => { throw new Error("attempted bypass"); },
      ctx,
    );
    // The result is an Err — caller (gateway) remains in control.
    expect(result.isOk).toBe(false);
  });
});
