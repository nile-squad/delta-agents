/**
 * Logger type contracts for delta-agents.
 *
 * The engine creates a per-engine logger at `createDeltaEngine` time and threads
 * it through the call chain. Each module that needs to log receives the logger
 * via DI and uses `logger.child(module)` to scope its entries. Pino is the
 * underlying engine — the public `Logger` type is a thin, ergonomic wrapper that
 * gives every module the same trace/debug/info/warn/error surface regardless of
 * which drain is configured. Drains are configuration concerns, not module
 * concerns.
 *
 * Drains:
 *   console — pino-pretty in dev, raw JSON in prod
 *   file    — append-only, daily YYYY-MM-DD.log under a configurable dir
 *   sqlite  — queryable, separate from the task store
 *   custom  — caller-provided sink for their own logging infrastructure
 */

/** Severity threshold the logger applies before any drain sees an entry. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Structured context carried alongside a log message. Optional in every call. */
export type LogContext = {
  taskId?: string;
  action?: string;
  executionId?: string;
  phase?: string;
  /** When present, overrides the child binding's module for this single entry. */
  module?: string;
};

/** A single log entry as seen by a custom drain. */
export type LogEntry = {
  level: LogLevel;
  module: string;
  message: string;
  context?: LogContext;
  /** ISO 8601 timestamp of when the entry was produced. */
  timestamp: string;
};

/** Where log entries go once pino has formatted them. */
export type LoggerDrain =
  | { type: "console" }
  | { type: "file"; dir?: string }
  | { type: "sqlite"; path?: string }
  | { type: "custom"; write: (entry: LogEntry) => void };

/** Per-engine logger configuration. The engine factory derives sane defaults. */
export type LoggerConfig = {
  /** Visual mode. Dev → pino-pretty colorized output; prod → raw JSON to drain. */
  mode?: "dev" | "prod";
  /** Minimum level that reaches the drain. Entries below it are dropped. */
  level?: LogLevel;
  /** Where entries are written. Default: console in dev, file in prod. */
  drain?: LoggerDrain;
};

/** Per-engine logger. The same surface for every module that needs to log. */
export type Logger = {
  trace: (message: string, context?: LogContext) => void;
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  /**
   * Return a child logger that auto-injects `module` into every entry. Children
   * inherit the parent's level and drain — the module is the only override.
   */
  child: (module: string) => Logger;
};
