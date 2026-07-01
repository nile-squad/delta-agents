/**
 * Per-module diagnostic toggles + factory.
 *
 * Diagnostics is the engine's optional observability surface. Every engine
 * module has a boolean flag in `DiagnosticsConfig`; when a flag is true, the
 * module emits structured events (timing, decision traces, counts) to the
 * per-engine logger at debug/trace level. When a flag is false, emission is
 * suppressed at the source — the module never touches the logger, the hot
 * path is never touched.
 *
 * Why a per-module toggle and not a global log-level filter:
 *   - The engine defaults to log level "info" in dev. Most diagnostic events
 *     belong at "debug" and would be dropped at the drain anyway. A toggle
 *     makes the developer opt in explicitly, with no global log-level churn.
 *   - Per-module toggles let the developer enable governance tracing without
 *     also enabling the noisy engine loop ticks.
 *   - The disabled path is provably zero overhead: `for(module)` returns a
 *     shared no-op emitter, and `event(...)` on it is a single function call
 *     to a function that returns undefined. No allocation, no logger hop.
 *
 * Allocation discipline:
 *   - The no-op emitter is a module-level constant. Every disabled `for()`
 *     returns the same instance.
 *   - Enabled emitters are built lazily on the first `for(module)` call AND
 *     cached. Subsequent calls return the same emitter, including its bound
 *     child logger — no per-call allocation in either path.
 */

import type { Logger } from "./logger-types";
import type { LogContext } from "./logger-types";

/**
 * Per-module diagnostic toggles. All default false — diagnostics are opt-in.
 * When a module's flag is true, that module emits structured events to the
 * per-engine logger at debug/trace level. When false, zero emission.
 */
export type DiagnosticsConfig = {
  actions?: boolean;
  workflows?: boolean;
  governance?: boolean;
  supervision?: boolean;
  memory?: boolean;
  comms?: boolean;
  tools?: boolean;
  engine?: boolean;
};

/** The set of module names that diagnostics can toggle. Matches the keys of
 * `DiagnosticsConfig`. Used for typed lookups and for compile-time validation
 * of module references in instrumentation sites. */
export type DiagnosticModule = keyof DiagnosticsConfig;

/** A per-module diagnostic emitter. When the module is disabled, every method
 * is a no-op (zero overhead — the hot path is never touched). */
export type DiagnosticEmitter = {
  /** Emit a debug-level event with structured context. */
  event: (name: string, context?: Record<string, string | number | boolean | null>) => void;
  /** Emit a trace-level event — finer-grained than `event`. */
  trace: (name: string, context?: Record<string, string | number | boolean | null>) => void;
  /** Measure the duration of a synchronous operation and emit a timing event
   * at debug level. Returns the result of the operation. */
  time: <T>(name: string, fn: () => T) => T;
  /** Measure the duration of an async operation and emit a timing event at
   * debug level. Returns the result of the operation. */
  timeAsync: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

/** A diagnostics handle: per-module enabled flags + per-module emitters.
 * Modules call `diag.for("actions")` to get their scoped diagnostic emitter.
 * If the module is disabled, the emitter's methods are no-ops. */
export type Diagnostics = {
  /** True if the named module has diagnostics enabled. */
  isEnabled: (module: DiagnosticModule) => boolean;
  /** Returns a scoped diagnostic emitter for a module. If the module is
   * disabled, returns the shared no-op emitter (same instance on every call).
   * If enabled, returns a per-module emitter cached for the engine's life. */
  for: (module: DiagnosticModule) => DiagnosticEmitter;
};

/**
 * The single shared no-op emitter. Allocated once at module load and reused
 * for every disabled module. The `time` and `timeAsync` methods still call
 * `fn` and return its result — they just skip the timing/emission overhead,
 * so a disabled call site behaves identically to a non-instrumented one.
 */
const NO_OP_EMITTER: DiagnosticEmitter = {
  event: () => {},
  trace: () => {},
  time: (_name, fn) => fn(),
  timeAsync: (_name, fn) => fn(),
};

/** Resolve a module's enabled state from the config, defaulting to false when
 * the field is absent. A missing `DiagnosticsConfig` is valid — every module
 * is then disabled. */
const isModuleEnabled = (config: DiagnosticsConfig, module: DiagnosticModule): boolean =>
  config[module] === true;

/**
 * Build an enabled emitter for a module. The emitter binds a child logger
 * scoped to the module name; every call carries the module binding in the
 * resulting log entry. The timing methods use `performance.now()` for
 * monotonic, high-resolution measurement.
 */
const buildEnabledEmitter = (child: Logger): DiagnosticEmitter => ({
  event: (name, context) => {
    // LogContext is the public typed contract; diagnostics carries arbitrary
    // structured context. The runtime accepts any payload — the cast is a
    // type-level escape hatch, not a runtime escape.
    if (context === undefined) child.debug(name);
    else child.debug(name, context as LogContext);
  },
  trace: (name, context) => {
    if (context === undefined) child.trace(name);
    else child.trace(name, context as LogContext);
  },
  time: <T>(name: string, fn: () => T): T => {
    const start = performance.now();
    const result = fn();
    const durationMs = performance.now() - start;
    child.debug(name, { durationMs } as LogContext);
    return result;
  },
  timeAsync: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const result = await fn();
    const durationMs = performance.now() - start;
    child.debug(name, { durationMs } as LogContext);
    return result;
  },
});

/**
 * Create the per-engine diagnostics handle.
 *
 * The returned `for(module)` returns either the shared no-op emitter (when
 * the module is disabled) or a per-module enabled emitter that forwards
 * events to the child logger bound to the module name. Emitters are cached
 * per-module — repeated `for(module)` calls return the same instance.
 */
export const createDiagnostics = (config: DiagnosticsConfig, logger: Logger): Diagnostics => {
  const emitters = new Map<DiagnosticModule, DiagnosticEmitter>();

  return {
    isEnabled: (module) => isModuleEnabled(config, module),
    for: (module) => {
      const cached = emitters.get(module);
      if (cached !== undefined) return cached;
      if (!isModuleEnabled(config, module)) {
        // Disabled path: bind once, reuse forever. No per-call allocation.
        emitters.set(module, NO_OP_EMITTER);
        return NO_OP_EMITTER;
      }
      // Enabled path: build a per-module child logger + emitter. The child
      // is the only place the module name enters the log entry; every call
      // is debug/trace level and never blocks the caller.
      const emitter = buildEnabledEmitter(logger.child(module));
      emitters.set(module, emitter);
      return emitter;
    },
  };
};
