/**
 * Central logging utility for delta-agents.
 *
 * All governance events carry TaskID context so the audit trail is always
 * attributable (Quality Bar: provenance is auditable).
 *
 * The global sink is null by default — no output until explicitly configured.
 * This keeps the library silent in tests unless the test opts into logging,
 * and lets integrators pipe entries to their own logging infrastructure.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  taskId?: string;
  action?: string;
  executionId?: string;
  phase?: string;
};

export type LogEntry = {
  level: LogLevel;
  module: string;
  message: string;
  context?: LogContext;
};

export type LogSink = (entry: LogEntry) => void;

export type Logger = {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
};

let globalSink: LogSink | null = null;

/** Set the global sink that all module loggers write to. Call once at engine startup. */
export const configureLogger = (sink: LogSink): void => {
  globalSink = sink;
};

/** Create a module-scoped logger. All entries include the module name. */
export const createLogger = (module: string): Logger => {
  const write = (level: LogLevel, message: string, context?: LogContext): void => {
    if (globalSink !== null) {
      globalSink({ level, module, message, context });
    }
  };
  return {
    debug: (msg, ctx) => write("debug", msg, ctx),
    info: (msg, ctx) => write("info", msg, ctx),
    warn: (msg, ctx) => write("warn", msg, ctx),
    error: (msg, ctx) => write("error", msg, ctx),
  };
};

/** Ready-made console sink for development and local testing. */
export const consoleLogSink: LogSink = ({ level, module, message, context }) => {
  const prefix = `[delta:${module}]`;
  const detail = context !== undefined ? ` ${JSON.stringify(context)}` : "";
  const line = `${prefix} ${message}${detail}`;
  switch (level) {
    case "debug": console.debug(line); break;
    case "info":  console.info(line);  break;
    case "warn":  console.warn(line);  break;
    case "error": console.error(line); break;
  }
};
