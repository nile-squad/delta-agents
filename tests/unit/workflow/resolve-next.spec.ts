/**
 * resolveNextStep unit tests.
 *
 * This is the deterministic routing brain of the phase runner. It must never
 * invent transitions — every route must be derivable solely from the declared
 * action list and the observed Result (invariant 21, prohibition 19).
 */

import { describe, it, expect } from "vitest";
import { Ok, Err } from "slang-ts";
import { resolveNextStep, findActionIndex } from "../../../src/workflow";
import type { ActionRef, ActionContext } from "../../../src/authoring";

const ctx: ActionContext = {
  taskId: "tsk_test",
  executionId: "exc_test",
  agentName: "test-agent",
};

const ok = Ok("done");
const err = Err("something failed");

// ── findActionIndex ───────────────────────────────────────────────────────────

describe("findActionIndex", () => {
  it("finds a string ref by name", () => {
    expect(findActionIndex(["a", "b", "c"], "b")).toBe(1);
  });

  it("finds a Branch ref by its action name", () => {
    const actions: ActionRef[] = [
      "prepare",
      { action: "verify", onSuccess: "fulfill" },
      "fulfill",
    ];
    expect(findActionIndex(actions, "verify")).toBe(1);
  });

  it("returns -1 when the name is not in the list", () => {
    expect(findActionIndex(["a", "b"], "missing")).toBe(-1);
  });

  it("returns the first match when the same name appears twice", () => {
    expect(findActionIndex(["a", "b", "a"], "a")).toBe(0);
  });
});

// ── Sequential string refs ────────────────────────────────────────────────────

describe("resolveNextStep — sequential (string refs)", () => {
  const actions: ActionRef[] = ["prepare", "execute", "confirm"];

  it("Ok on a middle action → continue to next index (sequential, not a jump)", () => {
    const result = resolveNextStep({ actions, currentIndex: 0, result: ok, ctx });
    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(result.nextIndex).toBe(1);
      expect(result.viaJump).toBe(false);
    }
  });

  it("Ok on the last action → end-success", () => {
    const result = resolveNextStep({ actions, currentIndex: 2, result: ok, ctx });
    expect(result.kind).toBe("end-success");
  });

  it("Err on any sequential action → end-failure with the fn error", () => {
    const result = resolveNextStep({ actions, currentIndex: 1, result: err, ctx });
    expect(result.kind).toBe("end-failure");
    if (result.kind === "end-failure") expect(result.reason).toContain("something failed");
  });

  it("single-action phase: Ok → end-success", () => {
    const result = resolveNextStep({ actions: ["only-action"], currentIndex: 0, result: ok, ctx });
    expect(result.kind).toBe("end-success");
  });
});

// ── Branch refs — success routing ────────────────────────────────────────────

describe("resolveNextStep — Branch: Ok routing", () => {
  const actions: ActionRef[] = [
    { action: "verify", onSuccess: "fulfill", onFailure: "notify" },
    "fulfill",
    "notify",
  ];

  it("Ok with onSuccess declared → continue to the named action's index (via jump)", () => {
    const result = resolveNextStep({ actions, currentIndex: 0, result: ok, ctx });
    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(result.nextIndex).toBe(1); // "fulfill" is at index 1
      expect(result.viaJump).toBe(true);
    }
  });

  it("Ok with no onSuccess declared → end-success (phase ends cleanly)", () => {
    const branchNoSuccess: ActionRef[] = [{ action: "check", onFailure: "handle-err" }, "handle-err"];
    const result = resolveNextStep({ actions: branchNoSuccess, currentIndex: 0, result: ok, ctx });
    expect(result.kind).toBe("end-success");
  });

  it("Ok routes to onSuccess, not onFailure (invariant 21)", () => {
    const result = resolveNextStep({ actions, currentIndex: 0, result: ok, ctx });
    // onSuccess = "fulfill" (index 1), NOT "notify" (index 2)
    if (result.kind === "continue") expect(result.nextIndex).not.toBe(2);
  });
});

// ── Branch refs — failure routing ────────────────────────────────────────────

describe("resolveNextStep — Branch: Err routing", () => {
  const actions: ActionRef[] = [
    { action: "verify", onSuccess: "fulfill", onFailure: "notify" },
    "fulfill",
    "notify",
  ];

  it("Err with onFailure declared → continue to the named action's index (via jump)", () => {
    const result = resolveNextStep({ actions, currentIndex: 0, result: err, ctx });
    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(result.nextIndex).toBe(2); // "notify" is at index 2
      expect(result.viaJump).toBe(true);
    }
  });

  it("Err with no onFailure declared → end-failure with the fn error", () => {
    const branchNoFailure: ActionRef[] = [{ action: "check", onSuccess: "ok-path" }, "ok-path"];
    const result = resolveNextStep({ actions: branchNoFailure, currentIndex: 0, result: err, ctx });
    expect(result.kind).toBe("end-failure");
    if (result.kind === "end-failure") expect(result.reason).toContain("something failed");
  });

  it("Err routes to onFailure, not onSuccess (invariant 21)", () => {
    const result = resolveNextStep({ actions, currentIndex: 0, result: err, ctx });
    // onFailure = "notify" (index 2), NOT "fulfill" (index 1)
    if (result.kind === "continue") expect(result.nextIndex).not.toBe(1);
  });
});

// ── Prohibition 19 — no undeclared transitions ────────────────────────────────

describe("resolveNextStep — prohibition 19: no undeclared transitions", () => {
  it("onSuccess target not in actions list → end-failure, not a jump to invented index", () => {
    const actions: ActionRef[] = [
      { action: "check", onSuccess: "ghost-action" },
    ];
    const result = resolveNextStep({ actions, currentIndex: 0, result: ok, ctx });
    expect(result.kind).toBe("end-failure");
    if (result.kind === "end-failure") {
      expect(result.reason).toContain('"ghost-action"');
      expect(result.reason).toMatch(/prohibition 19/i);
    }
  });

  it("onFailure target not in actions list → end-failure, not a jump to invented index", () => {
    const actions: ActionRef[] = [
      { action: "check", onFailure: "nowhere" },
    ];
    const result = resolveNextStep({ actions, currentIndex: 0, result: err, ctx });
    expect(result.kind).toBe("end-failure");
    if (result.kind === "end-failure") expect(result.reason).toContain('"nowhere"');
  });
});
