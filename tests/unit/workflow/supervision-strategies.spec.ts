/**
 * Supervision-strategy distinctness tests (H1).
 *
 * WHY: retry, restart, and resume were previously collapsed into the same
 * behaviour (re-run from index 0). This test suite proves they are now
 * observably distinct:
 *
 *   retry   — resumes from the failed action; earlier actions do NOT re-run.
 *   restart — re-runs from index 0 every attempt; all actions repeat.
 *   resume  — with no checkpoint (phase.checkpoint = false) falls back to
 *             restart behaviour, so aCount === restart's count.
 *
 * The canonical proof: a phase [a, flaky] where `a` increments a counter and
 * `flaky` fails twice then succeeds. Under retry, `a` runs once (retry skips
 * it). Under restart/resume(no-ckpt), `a` runs on each attempt (initial + 2
 * retries = 3 times).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { runWorkflow } from "../../../src/workflow";
import { createInMemoryStore } from "../../../src/ports";
import { initialTrust, initialRiskState } from "../../../src/governance";
import type { Action, Phase, Workflow } from "../../../src/authoring";
import type { TaskStateSnapshot } from "../../../src/state-space";
import type { SupervisionPolicy, Task, TaskTree } from "../../../src/shared/types";

// ── Shared helpers ────────────────────────────────────────────────────────────

const emptySchema = z.object({});

const makeAction = (name: string, fn: Action["fn"]): Action => ({
  name,
  description: `${name} action`,
  schema: emptySchema,
  fn,
});

const makePhase = (
  name: string,
  actions: string[],
  supervision?: SupervisionPolicy,
  checkpoint = false,
): Phase => ({
  name,
  description: `${name} phase`,
  actions,
  checkpoint,
  supervision,
});

const makeWorkflow = (phases: Phase[]): Workflow => ({
  name: "test-workflow",
  description: "test",
  version: "1.0.0",
  phases,
});

const makeState = (): TaskStateSnapshot => ({
  taskId: "tsk_h1_test",
  rootId: "tsk_h1_test",
  agentName: "test-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 100_000, durationMs: 300_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: initialRiskState(),
  trust: initialTrust(),
});

// ── Per-strategy counter setup ────────────────────────────────────────────────

/** Module-scoped counter that persists across action invocations (reset between cases). */
let aCount = 0;

/** Builds a [a, flaky] action registry where flaky fails `failTimes` times then succeeds. */
const makeRegistry = (failTimes: number): Map<string, Action> => {
  let flakyFailures = 0;
  return new Map([
    [
      "a",
      makeAction("a", async () => {
        aCount++;
        return Ok("a-ok");
      }),
    ],
    [
      "flaky",
      makeAction("flaky", async () => {
        if (flakyFailures < failTimes) {
          flakyFailures++;
          return Err("flaky-fail");
        }
        return Ok("flaky-ok");
      }),
    ],
  ]);
};

// Reset aCount before each test case so strategies don't bleed into each other.
beforeEach(() => {
  aCount = 0;
});

// ── Strategy tests ────────────────────────────────────────────────────────────

describe("supervision-strategies — H1 distinctness proof", () => {
  it("retry: resumes from the failed action — a never re-runs (aCount === 1)", async () => {
    // flaky fails 2 times; retry resumes at flaky each time so a only runs once
    const reg = makeRegistry(2);
    const phase = makePhase(
      "retry-phase",
      ["a", "flaky"],
      { strategy: "retry", maxRetries: 5 },
    );

    const result = await runWorkflow({
      workflow: makeWorkflow([phase]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: () => "none",
      inputFor: () => ({}),
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(aCount).toBe(1);
  });

  it("restart: re-runs from index 0 each attempt — a re-runs every attempt (aCount === 3)", async () => {
    // flaky fails 2 times; restart re-runs from index 0 each time → a runs on
    // the initial attempt + 2 retry attempts = 3 total
    const reg = makeRegistry(2);
    const phase = makePhase(
      "restart-phase",
      ["a", "flaky"],
      { strategy: "restart", maxRetries: 5 },
    );

    const result = await runWorkflow({
      workflow: makeWorkflow([phase]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: () => "none",
      inputFor: () => ({}),
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(aCount).toBe(3);
  });

  it("resume with no checkpoint (phase.checkpoint = false): falls back to restart → aCount === 3", async () => {
    // resume with no checkpoint id → applyStrategy returns restart → same as restart
    const reg = makeRegistry(2);
    const phase = makePhase(
      "resume-phase",
      ["a", "flaky"],
      { strategy: "resume", maxRetries: 5 },
      false, // no checkpoint → resume falls back to restart
    );

    const result = await runWorkflow({
      workflow: makeWorkflow([phase]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: () => "none",
      inputFor: () => ({}),
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(aCount).toBe(3);
  });
});

// ── abort-subtree vs abort-tree distinctness ───────────────────────────────────

/**
 * abort-subtree and abort-tree were previously collapsed onto the same single-task
 * abortTask call, so a declared abort-tree silently failed to cascade. These tests
 * prove the two are now observably distinct: abort-subtree aborts only the failing
 * task and leaves its sibling running; abort-tree cascades from the snapshot's rootId
 * and aborts the root plus every active/queued child, then clears the tree.
 */

const makeTask = (id: string, rootId: string): Task => ({
  id,
  rootId,
  status: "running",
  goal: `goal for ${id}`,
  assignedAgent: "test-agent",
  budget: { tokens: 100_000, durationMs: 300_000 },
  risk: initialRiskState(),
  trust: initialTrust(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeTree = (rootTaskId: string, active: string[]): TaskTree => ({
  rootTaskId,
  activeChildren: active,
  queuedChildren: [],
  maxConcurrency: 2,
});

const alwaysFails = makeAction("boom", async () => Err("boom"));

const runWithStrategy = async (strategy: SupervisionPolicy["strategy"]) => {
  // Root task with one active child, both persisted; the workflow runs on the root
  // and its single phase always fails, triggering the declared abort strategy.
  const store = createInMemoryStore();
  await store.saveTask(makeTask("tsk_root", "tsk_root"));
  await store.saveTask(makeTask("tsk_child", "tsk_root"));
  await store.saveTaskTree(makeTree("tsk_root", ["tsk_child"]));

  const phase = makePhase("boom-phase", ["boom"], { strategy, maxRetries: 0 });
  const result = await runWorkflow({
    workflow: makeWorkflow([phase]),
    actionRegistry: new Map([["boom", alwaysFails]]),
    state: { ...makeState(), taskId: "tsk_root", rootId: "tsk_root" },
    getApprovalStatus: () => "none",
    inputFor: () => ({}),
    store,
  });

  const root = await store.getTask("tsk_root");
  const child = await store.getTask("tsk_child");
  const tree = await store.getTaskTree("tsk_root");
  return { result, store, root, child, tree };
};

describe("supervision-strategies — abort-subtree vs abort-tree", () => {
  it("abort-subtree aborts only the failing task; the sibling child stays running", async () => {
    const { result, root, child } = await runWithStrategy("abort-subtree");

    expect(result.status).toBe("failed");
    if (root.isOk) expect(root.value.status).toBe("aborted");
    // The child was NOT touched — abort-subtree is scoped to the single task.
    if (child.isOk) expect(child.value.status).toBe("running");
  });

  it("abort-tree cascades: root and child are aborted and the tree is cleared", async () => {
    const { result, root, child, tree } = await runWithStrategy("abort-tree");

    expect(result.status).toBe("failed");
    if (root.isOk) expect(root.value.status).toBe("aborted");
    // The child IS aborted — abort-tree cascades the whole tree (invariant 17).
    if (child.isOk) expect(child.value.status).toBe("aborted");
    // The tree is cleared so no queued child is later promoted (prohibition 11).
    if (tree.isOk) expect(tree.value.activeChildren).toEqual([]);
  });
});
