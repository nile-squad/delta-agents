/**
 * Consumer events tests — the common envelope and per-event payload fields.
 *
 * Two contracts are load-bearing here:
 *   1. Every DELIVERED event carries a `timestamp` (the envelope), stamped
 *      centrally by `emit` — callers pass the BARE payload. This must hold for
 *      events bridged in from diagnostics too, which never build the envelope.
 *   2. Every non-task event now carries `agentName`, so an audit/UI feed can
 *      attribute an event to an agent without a secondary lookup.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createEvents } from "../../../src/shared/create-events";
import type { DeltaEventsInternal, DeltaEventDelivered } from "../../../src/shared/create-events";
import { createEngineLogger } from "../../../src/shared/logger";
import { createDiagnostics } from "../../../src/shared/diagnostics";

describe("createEvents — envelope (timestamp)", () => {
  let events: DeltaEventsInternal;

  beforeEach(() => {
    events = createEvents();
  });

  it("stamps a numeric timestamp on every delivered event, from a bare payload", () => {
    const received: DeltaEventDelivered<"task-completed">[] = [];
    events.on("task-completed", (d) => received.push(d));

    const before = Date.now();
    // Caller supplies the BARE payload — no timestamp.
    events.emit("task-completed", { taskId: "t1", agentName: "alice", goal: "ship it" });
    const after = Date.now();

    expect(received).toHaveLength(1);
    expect(typeof received[0]!.timestamp).toBe("number");
    expect(received[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(received[0]!.timestamp).toBeLessThanOrEqual(after);
    // Payload fields survive alongside the stamped envelope.
    expect(received[0]!.taskId).toBe("t1");
    expect(received[0]!.agentName).toBe("alice");
    expect(received[0]!.goal).toBe("ship it");
  });

  it("stamps timestamps independently per emission (monotonic, not shared)", () => {
    const stamps: number[] = [];
    events.on("step-start", (d) => stamps.push(d.timestamp));
    events.emit("step-start", { taskId: "t1", agentName: "alice", step: 0 });
    events.emit("step-start", { taskId: "t1", agentName: "alice", step: 1 });
    expect(stamps).toHaveLength(2);
    expect(stamps[1]!).toBeGreaterThanOrEqual(stamps[0]!);
  });

  it("off() unsubscribes and the returned disposer also unsubscribes", () => {
    const handler = vi.fn();
    const dispose = events.on("task-failed", handler);
    events.emit("task-failed", { taskId: "t1", agentName: "alice", reason: "boom" });
    expect(handler).toHaveBeenCalledTimes(1);

    dispose();
    events.emit("task-failed", { taskId: "t1", agentName: "alice", reason: "boom" });
    expect(handler).toHaveBeenCalledTimes(1);

    const h2 = vi.fn();
    events.on("task-failed", h2);
    events.off("task-failed", h2);
    events.emit("task-failed", { taskId: "t1", agentName: "alice", reason: "boom" });
    expect(h2).not.toHaveBeenCalled();
  });
});

describe("createEvents — agentName present per event", () => {
  it("carries agentName on every non-task lifecycle event payload", () => {
    const events = createEvents();
    const seen: Record<string, unknown> = {};
    events.on("approval-requested", (d) => { seen["approval-requested"] = d.agentName; });
    events.on("approval-resolved", (d) => { seen["approval-resolved"] = d.agentName; });
    events.on("escalation-raised", (d) => { seen["escalation-raised"] = d.agentName; });
    events.on("step-end", (d) => { seen["step-end"] = d.agentName; });
    events.on("commit-step-attempt", (d) => { seen["commit-step-attempt"] = d.agentName; });
    events.on("action-start", (d) => { seen["action-start"] = d.agentName; });

    events.emit("approval-requested", { taskId: "t", agentName: "a1", action: "x", approvalId: "ap", reason: "r" });
    events.emit("approval-resolved", { taskId: "t", agentName: "a2", action: "x", approvalId: "ap", decision: "approved" });
    events.emit("escalation-raised", { taskId: "t", agentName: "a3", trigger: "budget-violation", reason: "r" });
    events.emit("step-end", { taskId: "t", agentName: "a4", step: 1, kind: "stepped" });
    events.emit("commit-step-attempt", { taskId: "t", agentName: "a5", attempt: 0, workflowName: "w" });
    events.emit("action-start", { action: "x", agentName: "a6", taskId: "t", executionId: "e" });

    expect(seen).toEqual({
      "approval-requested": "a1",
      "approval-resolved": "a2",
      "escalation-raised": "a3",
      "step-end": "a4",
      "commit-step-attempt": "a5",
      "action-start": "a6",
    });
  });
});

describe("createEvents — diagnostics bridge is enveloped too", () => {
  it("timestamps events dispatched through the diagnostics bridge", () => {
    const events = createEvents();
    const received: DeltaEventDelivered<"step-start">[] = [];
    events.on("step-start", (d) => received.push(d));

    // Same wiring create-delta-engine uses: diagnostics.event() forwards to
    // events.emit via the emitEvent callback. The bridge never builds the
    // envelope itself, so emit must stamp it.
    const logger = createEngineLogger({ level: "trace", drain: { type: "custom", write: () => {} } });
    const diagnostics = createDiagnostics({ engine: true }, logger, (name, context) => {
      events.emit(name as never, context as never);
    });

    const before = Date.now();
    diagnostics.for("engine").event("step-start", { taskId: "t1", agentName: "alice", step: 0 });
    const after = Date.now();

    expect(received).toHaveLength(1);
    expect(typeof received[0]!.timestamp).toBe("number");
    expect(received[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(received[0]!.timestamp).toBeLessThanOrEqual(after);
    expect(received[0]!.agentName).toBe("alice");
  });
});
