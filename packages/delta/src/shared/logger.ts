/**
 * Per-engine logger factory. Pino is the underlying engine for every drain.
 *
 * The public `Logger` type is a thin, ergonomic wrapper around pino's logger
 * API. It hides pino's level numbers, normalizes child creation behind
 * `child(module)`, and routes entries to a drain that the configuration picks.
 * Every module in the engine receives its `Logger` via DI; the per-engine
 * instance lives for the engine's lifetime and is never shared across engines.
 *
 * Drain dispatch:
 *   - dev + console → pino-pretty stream (colorized, human-readable)
 *   - prod + console → pino's default stdout (raw JSON, one entry per line)
 *   - file → custom Writable, append-only, daily-rotated YYYY-MM-DD.log
 *   - sqlite → custom Writable, parses each line and inserts into a `logs` table
 *   - custom → custom Writable, parses each line and forwards to caller sink
 *
 * Log drain failures NEVER throw — a logger that destabilizes the very system
 * it audits is worse than a missing entry. Each drain swallows its own errors
 * silently so the engine's hot path is never blocked by a logging fault.
 */

import { Writable } from "stream";
import * as fs from "fs";
import * as path from "path";
import pino, { type Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";
import { createSqliteLogDrain } from "../ports/log-sqlite";
import type { LogContext, LogEntry, Logger, LoggerConfig, LoggerDrain, LogLevel } from "./logger-types";

const DEFAULT_FILE_DIR = ".delta-logs";
const DEFAULT_SQLITE_PATH = "delta-logs.sqlite";

/** Map our string level onto pino's API. Pino accepts the string directly, but
 * we keep a record for parsing pino output back to our string. */
const PINO_NUMBER_TO_LEVEL: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "error",
};

/** Today's date as YYYY-MM-DD in the local timezone — matches the spec's
 * date-only filename and keeps the file human-sortable. */
const todayDateString = (): string => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/** Strip pino's reserved fields and our internal `module` binding from a context
 * object before forwarding to pino. The child's `module` binding already covers
 * the module; a stray `module` in the call-site context would override it. */
const stripReserved = (context: LogContext): Record<string, unknown> => {
  const { module: _omitted, ...rest } = context;
  return rest;
};

/** Writable stream that appends each pino line to a daily-rotated file under
 * `dir`. One open file per UTC day; we close and reopen when the date changes.
 * The `flags: "a"` write stream is append-only — never truncates. */
const createFileDrainStream = (dir: string): Writable => {
  const absoluteDir = path.resolve(dir);
  let currentDate: string | null = null;
  let currentStream: fs.WriteStream | null = null;

  const ensureStream = (date: string): fs.WriteStream => {
    if (currentDate === date && currentStream !== null) return currentStream;
    if (currentStream !== null) currentStream.end();
    fs.mkdirSync(absoluteDir, { recursive: true });
    currentStream = fs.createWriteStream(path.join(absoluteDir, `${date}.log`), { flags: "a" });
    currentDate = date;
    return currentStream;
  };

  return new Writable({
    write(chunk, _encoding, callback): void {
      try {
        ensureStream(todayDateString()).write(chunk);
      } catch {
        // drain failures swallow
      } finally {
        callback();
      }
    },
  });
};

/** Parse a single pino JSON line back into our public `LogEntry` shape. Returns
 * null when the line is not a valid pino entry — the caller skips the line. */
const parsePinoLine = (line: string): LogEntry | null => {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const levelNumber = typeof obj["level"] === "number" ? obj["level"] : 30;
  const level = PINO_NUMBER_TO_LEVEL[levelNumber] ?? "info";
  const message = typeof obj["msg"] === "string" ? obj["msg"] : "";
  const time = typeof obj["time"] === "number" ? obj["time"] : Date.now();
  const module = typeof obj["module"] === "string" ? obj["module"] : "";
  // Strip pino's reserved fields; everything else is user context.
  const reserved = new Set(["level", "time", "msg", "pid", "hostname", "module"]);
  const context: LogContext = {};
  let hasContext = false;
  for (const [k, v] of Object.entries(obj)) {
    if (reserved.has(k)) continue;
    if (v === undefined) continue;
    (context as Record<string, unknown>)[k] = v;
    hasContext = true;
  }
  return {
    level,
    module,
    message,
    ...(hasContext ? { context } : {}),
    timestamp: new Date(time).toISOString(),
  };
};

/** Writable stream that parses each pino line and forwards a `LogEntry` to
 * `write`. Used for sqlite and custom drains — both want our public entry
 * shape, not pino's raw JSON. */
const createEntryDrainStream = (write: (entry: LogEntry) => void): Writable =>
  new Writable({
    write(chunk, _encoding, callback): void {
      try {
        const entry = parsePinoLine(chunk.toString().trim());
        if (entry !== null) write(entry);
      } catch {
        // drain failures swallow
      } finally {
        callback();
      }
    },
  });

/** Build the pino destination stream for a non-console drain. Console is
 * handled inline (pino's default stdout, or a pino-pretty stream). */
const buildDrainStream = (drain: LoggerDrain): Writable | undefined => {
  switch (drain.type) {
    case "file":
      return createFileDrainStream(drain.dir ?? DEFAULT_FILE_DIR);
    case "sqlite": {
      const sqliteDrain = createSqliteLogDrain(drain.path ?? DEFAULT_SQLITE_PATH);
      return createEntryDrainStream(sqliteDrain.drain);
    }
    case "custom":
      return createEntryDrainStream(drain.write);
    case "console":
      return undefined;
  }
};

/**
 * Create a per-engine logger.
 *
 * Defaults:
 *   - mode   = "dev"  (pino-pretty colorized output)
 *   - level  = "info" (trace/debug entries are dropped)
 *   - drain  = console in dev, file (.delta-logs/) in prod
 *
 * The returned logger and every child it produces share one pino instance; the
 * module binding is the only difference between a parent and its child.
 */
export const createEngineLogger = (config?: LoggerConfig): Logger => {
  const mode = config?.mode ?? "dev";
  const level = config?.level ?? "info";
  const drain = config?.drain ?? (mode === "dev" ? { type: "console" } : { type: "file" });

  const pinoOptions: pino.LoggerOptions = {
    level,
    // Drop pino's pid/hostname defaults — the engine never wants them, and
    // they add noise to every line.
    base: undefined,
  };

  let pinoLogger: PinoLogger;

  if (drain.type === "console") {
    if (mode === "dev") {
      // pino-pretty stream: colorized, human-readable. No worker thread.
      pinoLogger = pino(pinoOptions, pretty({ colorize: true, translateTime: "SYS:HH:MM:ss.l" }));
    } else {
      // prod console: raw JSON to stdout, one entry per line.
      pinoLogger = pino(pinoOptions);
    }
  } else {
    const stream = buildDrainStream(drain);
    pinoLogger = stream === undefined ? pino(pinoOptions) : pino(pinoOptions, stream);
  }

  const wrap = (p: PinoLogger): Logger => {
    const emit = (levelName: LogLevel, message: string, context?: LogContext): void => {
      if (context === undefined) {
        p[levelName](message);
        return;
      }
      const payload = stripReserved(context);
      if (Object.keys(payload).length === 0) {
        p[levelName](message);
      } else {
        p[levelName](payload, message);
      }
    };
    return {
      trace: (m, c) => emit("trace", m, c),
      debug: (m, c) => emit("debug", m, c),
      info: (m, c) => emit("info", m, c),
      warn: (m, c) => emit("warn", m, c),
      error: (m, c) => emit("error", m, c),
      child: (module) => wrap(p.child({ module })),
    };
  };

  return wrap(pinoLogger);
};
