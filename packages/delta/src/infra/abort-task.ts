/**
 * Abort-and-promise utility — the interim execution model.
 *
 * True actor isolation and message-passing come later (context.md §Tech Stack).
 * For now, all async work runs inside a plain Promise wrapped with an AbortController.
 * Callers get a handle to cancel in-flight work on task abort, pause, or timeout.
 *
 * The spec requires that aborting a parent task aborts all descendants (invariant 17).
 * This primitive is the building block that makes that property enforceable:
 * supervision holds a handle to every in-flight AbortableTask and calls abort() on cascade.
 */

export type AbortableTask<T> = {
  /** The underlying promise. Resolves or rejects based on fn's outcome. */
  promise: Promise<T>;
  /** Cancel the task. The signal passed to fn will become aborted. */
  abort: (reason?: string) => void;
  /** True once abort() has been called. */
  isAborted: () => boolean;
};

export const createAbortableTask = <T>({
  fn,
}: {
  fn: (signal: AbortSignal) => Promise<T>;
}): AbortableTask<T> => {
  const controller = new AbortController();

  return {
    promise: fn(controller.signal),
    abort: (reason) => controller.abort(reason),
    isAborted: () => controller.signal.aborted,
  };
};
