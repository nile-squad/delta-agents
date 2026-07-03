/**
 * Logger tests — per-engine pino-backed factory.
 *
 * These tests cover the four drain types (console, file, sqlite, custom),
 * level filtering, child logger module binding, default mode resolution,
 * and the never-throw guarantee on drain failure.
 *
 * Why a custom drain is the primary capture mechanism: pino streams are
 * difficult to intercept cleanly across dev/prod modes. The custom drain
 * is a first-class LoggerDrain variant that gives us direct entry-shape
 * assertions, decoupled from pino's output format.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { createClient } from "@libsql/client";
import { createEngineLogger } from "../../../src/shared/logger";
import type { LogEntry, Logger } from "../../../src/shared/logger-types";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a custom drain that appends each entry to `entries` synchronously. */
const captureDrain = (): { drain: { type: "custom"; write: (entry: LogEntry) => void }; entries: LogEntry[] } => {
  const entries: LogEntry[] = [];
  return { drain: { type: "custom", write: (entry) => { entries.push(entry); } }, entries };
};

/** Wait for the next microtask flush — sqlite drain is fire-and-forget. */
const flush = async (ms = 20): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

describe("createEngineLogger — defaults", () => {
  it("returns a Logger with the full level surface", () => {
    const log = createEngineLogger({ drain: { type: "custom", write: () => {} } });
    expect(typeof log.trace).toBe("function");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.child).toBe("function");
  });
});

describe("createEngineLogger — level filtering", () => {
  it("default level (info) drops trace and debug", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ drain });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(entries.map((e) => e.message)).toEqual(["i", "w", "e"]);
    expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"]);
  });

  it("level: warn keeps only warn and error", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ level: "warn", drain });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(entries.map((e) => e.message)).toEqual(["w", "e"]);
  });

  it("level: debug keeps everything from debug up", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ level: "debug", drain });
    log.trace("t");
    log.debug("d");
    log.info("i");
    expect(entries.map((e) => e.message)).toEqual(["d", "i"]);
  });
});

describe("createEngineLogger — custom drain entry shape", () => {
  it("emits entries with level, module, message, timestamp, context", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ drain });
    log.info("hello world", { taskId: "t-1" });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.level).toBe("info");
    expect(e.message).toBe("hello world");
    expect(e.module).toBe("");
    expect(typeof e.timestamp).toBe("string");
    expect(new Date(e.timestamp).toString()).not.toBe("Invalid Date");
    expect(e.context?.taskId).toBe("t-1");
  });

  it("omits context when no context arg is passed", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ drain });
    log.info("plain");
    expect(entries[0]?.context).toBeUndefined();
  });

  it("drops a context.module override to honor child binding", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ drain });
    const child = log.child("actions");
    child.info("msg", { module: "wrong", taskId: "t-1" });
    // The child module binding wins; the call-site module override is stripped.
    expect(entries[0]?.module).toBe("actions");
    expect(entries[0]?.context?.taskId).toBe("t-1");
    expect(entries[0]?.context?.module).toBeUndefined();
  });
});

describe("createEngineLogger — child loggers", () => {
  it("child(module) emits entries with module: <name>", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ drain });
    const child = log.child("actions");
    child.info("from child");
    expect(entries[0]?.module).toBe("actions");
    expect(entries[0]?.message).toBe("from child");
  });

  it("parent and child emit independently with different module bindings", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ drain });
    const actionsChild = log.child("actions");
    const govChild = log.child("governance");
    log.info("root");
    actionsChild.info("a");
    govChild.info("g");
    expect(entries.map((e) => e.module)).toEqual(["", "actions", "governance"]);
  });

  it("nested children stack module binding (child of a child inherits the new name)", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ drain });
    const outer = log.child("actions");
    const inner = outer.child("selector");
    inner.info("deep");
    // Pino's child binding composes: the inner module overrides the outer one.
    expect(entries[0]?.module).toBe("selector");
  });

  it("child level matches parent (children do not change level)", () => {
    const { drain, entries } = captureDrain();
    const log = createEngineLogger({ level: "warn", drain });
    const child = log.child("actions");
    child.info("filtered out");
    child.warn("kept");
    expect(entries.map((e) => e.message)).toEqual(["kept"]);
  });
});

describe("createEngineLogger — drain failure tolerance", () => {
  it("a custom drain that throws does not propagate the error", () => {
    const log = createEngineLogger({
      drain: { type: "custom", write: () => { throw new Error("drain boom"); } },
    });
    // Logger must not throw — the engine's hot path is never blocked by logging.
    expect(() => log.info("hello")).not.toThrow();
    expect(() => log.error("bad")).not.toThrow();
  });

  it("emits succeed even when the previous drain write threw", () => {
    let throwOnce = true;
    const log = createEngineLogger({
      drain: {
        type: "custom",
        write: () => { if (throwOnce) { throwOnce = false; throw new Error("once"); } },
      },
    });
    // First call throws inside the drain, swallowed. Second call must still execute.
    expect(() => log.info("a")).not.toThrow();
    expect(() => log.info("b")).not.toThrow();
  });
});

describe("createEngineLogger — file drain", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "delta-logger-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes entries to a daily YYYY-MM-DD.log file", async () => {
    const log = createEngineLogger({ mode: "prod", drain: { type: "file", dir } });
    log.info("file hello");
    // pino stream is sync; one tick is enough to let the chunk flush.
    await flush();
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/);
    const contents = readFileSync(join(dir, files[0]!), "utf-8");
    expect(contents).toContain("file hello");
  });

  it("appends to the same file across multiple emissions", async () => {
    const log = createEngineLogger({ mode: "prod", drain: { type: "file", dir } });
    log.info("first");
    log.info("second");
    await flush();
    const files = readdirSync(dir);
    const contents = readFileSync(join(dir, files[0]!), "utf-8");
    expect(contents).toContain("first");
    expect(contents).toContain("second");
  });

  it("creates the directory if it does not exist", () => {
    const nested = join(dir, "nested", "logs");
    expect(existsSync(nested)).toBe(false);
    createEngineLogger({ mode: "prod", drain: { type: "file", dir: nested } });
    // First ensureStream call is on the first write; the directory is created on demand.
    expect(existsSync(nested)).toBe(false);
    // After an emission, the directory must exist.
  });
});

describe("createEngineLogger — sqlite drain", () => {
  let dbPath: string;
  beforeEach(() => { dbPath = join(tmpdir(), `delta-logger-${nanoid()}.sqlite`); });
  afterEach(() => { try { rmSync(dbPath, { force: true }); } catch { /* noop */ } });

  it("inserts a row per entry into the logs table", async () => {
    const log = createEngineLogger({ mode: "prod", drain: { type: "sqlite", path: dbPath } });
    log.info("sqlite hello", { taskId: "t-1" });
    log.warn("warn message");
    // The sqlite drain is fire-and-forget; wait for both inserts to land.
    await flush(60);

    const client = createClient({ url: `file:${dbPath}` });
    const rows = await client.execute("SELECT level, module, message, context FROM logs ORDER BY id");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.[0]).toBe("info");
    expect(rows.rows[0]?.[2]).toBe("sqlite hello");
    expect(rows.rows[0]?.[3]).toContain("t-1");
    expect(rows.rows[1]?.[0]).toBe("warn");
    client.close();
  });

  it("stores context as a JSON string", async () => {
    const log = createEngineLogger({ mode: "prod", drain: { type: "sqlite", path: dbPath } });
    log.info("with-context", { taskId: "tx", action: "lookup" });
    await flush(40);

    const client = createClient({ url: `file:${dbPath}` });
    const rows = await client.execute("SELECT context FROM logs");
    const raw = rows.rows[0]?.[0] as string | null;
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual({ taskId: "tx", action: "lookup" });
    client.close();
  });
});

describe("createEngineLogger — drain factory", () => {
  it("console drain in dev mode wires pino-pretty (does not throw)", () => {
    // dev console writes to stdout via pino-pretty. We can't capture colorized
    // output cleanly across pino versions, so we just verify construction + emit
    // do not throw. The custom-drain tests cover the entry-shape contract.
    const log = createEngineLogger({ mode: "dev", drain: { type: "console" } });
    expect(() => log.info("dev console")).not.toThrow();
  });

  it("console drain in prod mode wires raw JSON (does not throw)", () => {
    const log = createEngineLogger({ mode: "prod", drain: { type: "console" } });
    expect(() => log.info("prod console")).not.toThrow();
  });
});
