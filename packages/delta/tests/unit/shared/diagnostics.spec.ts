/**
 * Diagnostics tests — per-module toggles and the no-op fast path.
 *
 * The disabled path is the most important contract here: every call site
 * uses `diag.for("...")`, and the returned emitter must be the shared no-op
 * when the module is disabled. Allocating a new emitter on every disabled
 * call would defeat the zero-overhead guarantee.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createEngineLogger } from "../../../src/shared/logger";
import type { LogEntry, Logger } from "../../../src/shared/logger-types";
import { createDiagnostics } from "../../../src/shared/diagnostics";
import type { DiagnosticModule, DiagnosticEmitter } from "../../../src/shared/diagnostics";

const captureLogger = (): { logger: Logger; entries: LogEntry[] } => {
  const entries: LogEntry[] = [];
  const logger = createEngineLogger({
    level: "trace",
    drain: { type: "custom", write: (e) => { entries.push(e); } },
  });
  return { logger, entries };
};

describe("createDiagnostics — isEnabled", () => {
  it("returns false for every module when config is empty", () => {
    const { logger } = captureLogger();
    const diag = createDiagnostics({}, logger);
    const modules: DiagnosticModule[] = ["actions", "workflows", "governance", "supervision", "memory", "comms", "tools", "engine"];
    for (const m of modules) {
      expect(diag.isEnabled(m)).toBe(false);
    }
  });

  it("returns true only for the modules explicitly enabled in config", () => {
    const { logger } = captureLogger();
    const diag = createDiagnostics({ actions: true, governance: true }, logger);
    expect(diag.isEnabled("actions")).toBe(true);
    expect(diag.isEnabled("governance")).toBe(true);
    expect(diag.isEnabled("workflows")).toBe(false);
    expect(diag.isEnabled("engine")).toBe(false);
  });

  it("a missing config has every module disabled", () => {
    const { logger } = captureLogger();
    const diag = createDiagnostics({}, logger);
    expect(diag.isEnabled("actions")).toBe(false);
  });
});

describe("createDiagnostics — for() disabled path (no-op)", () => {
  let logger: Logger;
  let entries: LogEntry[];
  let diag: ReturnType<typeof createDiagnostics>;

  beforeEach(() => {
    const cap = captureLogger();
    logger = cap.logger;
    entries = cap.entries;
    diag = createDiagnostics({}, logger);
  });

  it("event() is a no-op (no logger entry produced)", () => {
    diag.for("actions").event("decision-made", { candidate: "lookup" });
    expect(entries).toHaveLength(0);
  });

  it("trace() is a no-op", () => {
    diag.for("actions").trace("inner-trace", { x: 1 });
    expect(entries).toHaveLength(0);
  });

  it("time() runs the function and returns its result, emits nothing", () => {
    const result = diag.for("actions").time("op", () => 42);
    expect(result).toBe(42);
    expect(entries).toHaveLength(0);
  });

  it("timeAsync() runs the function and returns its result, emits nothing", async () => {
    const result = await diag.for("actions").timeAsync("async-op", async () => "done");
    expect(result).toBe("done");
    expect(entries).toHaveLength(0);
  });

  it("returns the same emitter instance for every disabled call (shared no-op)", () => {
    const a = diag.for("actions");
    const b = diag.for("actions");
    const c = diag.for("governance");
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Identity is the point: zero allocation per call site.
    expect(a).toBe(diag.for("actions"));
  });
});

describe("createDiagnostics — for() enabled path", () => {
  it("event() emits a debug-level entry with the module binding", () => {
    const { logger, entries } = captureLogger();
    const diag = createDiagnostics({ actions: true }, logger);
    diag.for("actions").event("candidate-evaluated", { action: "lookup" });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.level).toBe("debug");
    expect(e.module).toBe("actions");
    expect(e.message).toBe("candidate-evaluated");
    expect(e.context?.action).toBe("lookup");
  });

  it("trace() emits a trace-level entry", () => {
    const { logger, entries } = captureLogger();
    const diag = createDiagnostics({ governance: true }, logger);
    diag.for("governance").trace("step-detail", { step: 3 });
    expect(entries[0]?.level).toBe("trace");
    expect(entries[0]?.module).toBe("governance");
  });

  it("time() runs the function AND emits a timing event", () => {
    const { logger, entries } = captureLogger();
    const diag = createDiagnostics({ actions: true }, logger);
    const result = diag.for("actions").time("op", () => "fn-result");
    expect(result).toBe("fn-result");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("op");
    // Context is a typed LogContext on the public surface; the runtime passes
    // a wider payload that includes durationMs. Read the raw entry to check
    // timing was emitted.
    const ctx = entries[0]?.context as Record<string, unknown> | undefined;
    expect(ctx?.["durationMs"]).toBeTypeOf("number");
    expect(ctx?.["durationMs"] as number).toBeGreaterThanOrEqual(0);
  });

  it("timeAsync() runs the function AND emits a timing event", async () => {
    const { logger, entries } = captureLogger();
    const diag = createDiagnostics({ actions: true }, logger);
    const result = await diag.for("actions").timeAsync("async-op", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "async-result";
    });
    expect(result).toBe("async-result");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("async-op");
    const ctx = entries[0]?.context as Record<string, unknown> | undefined;
    expect(ctx?.["durationMs"] as number).toBeGreaterThanOrEqual(0);
  });

  it("enabled emitter is cached (same instance on every call)", () => {
    const { logger, entries: _entries } = captureLogger();
    const diag = createDiagnostics({ actions: true }, logger);
    const a = diag.for("actions");
    const b = diag.for("actions");
    expect(a).toBe(b);
  });

  it("emits only at debug/trace — info+ entries from the logger are dropped", () => {
    const { entries: capEntries } = captureLogger();
    const logger = createEngineLogger({
      level: "info",
      drain: { type: "custom", write: (e) => { capEntries.push(e); } },
    });
    const diag = createDiagnostics({ actions: true }, logger);
    diag.for("actions").event("e");        // debug → dropped
    diag.for("actions").trace("t");        // trace → dropped
    expect(capEntries).toHaveLength(0);
  });
});

describe("createDiagnostics — mixed enabled/disabled per module", () => {
  it("only emits for the enabled modules; disabled ones stay quiet", () => {
    const { logger, entries } = captureLogger();
    const diag = createDiagnostics({ actions: true, governance: true }, logger);
    diag.for("actions").event("a-event");
    diag.for("workflows").event("w-event");     // disabled
    diag.for("governance").event("g-event");
    diag.for("engine").event("e-event");        // disabled
    expect(entries.map((e) => e.message)).toEqual(["a-event", "g-event"]);
  });
});
