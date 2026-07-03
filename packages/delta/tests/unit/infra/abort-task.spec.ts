import { describe, it, expect } from "vitest";
import { createAbortableTask } from "../../../src/infra";

describe("AbortableTask", () => {
  it("resolves when fn completes normally", async () => {
    const task = createAbortableTask({ fn: async () => "done" });
    const result = await task.promise;
    expect(result).toBe("done");
  });

  it("isAborted starts false", () => {
    const task = createAbortableTask({ fn: async (_signal) => "ok" });
    expect(task.isAborted()).toBe(false);
  });

  it("isAborted becomes true after abort()", () => {
    const task = createAbortableTask({
      fn: (_signal) => new Promise(() => { /* never resolves */ }),
    });
    task.abort();
    expect(task.isAborted()).toBe(true);
  });

  it("abort() sets aborted on the signal that was passed to fn", async () => {
    // Use a container object so TypeScript's control-flow narrowing cannot
    // collapse the type to `never` through the async callback closure.
    const state = { signal: null as AbortSignal | null };
    const task = createAbortableTask({
      fn: async (signal) => {
        state.signal = signal;
        return "result";
      },
    });
    await task.promise;
    task.abort("test-reason");
    expect(state.signal?.aborted).toBe(true);
  });

  it("abort reason is passed through to the signal", () => {
    const state = { signal: null as AbortSignal | null };
    const task = createAbortableTask({
      fn: async (signal) => {
        state.signal = signal;
      },
    });
    task.abort("my-reason");
    expect(state.signal?.reason).toBe("my-reason");
  });

  it("calling abort multiple times does not throw", () => {
    const task = createAbortableTask({
      fn: (_signal) => new Promise(() => { /* never resolves */ }),
    });
    expect(() => {
      task.abort();
      task.abort();
      task.abort();
    }).not.toThrow();
  });

  it("fn receives the signal and can check aborted flag", async () => {
    let signalAbortedDuringRun = false;
    const task = createAbortableTask({
      fn: async (signal) => {
        signalAbortedDuringRun = signal.aborted;
        return "ok";
      },
    });
    await task.promise;
    // Signal was not aborted when fn ran
    expect(signalAbortedDuringRun).toBe(false);
  });
});
