/**
 * Workflow pause/resume correctness across mid-workflow escalations.
 *
 * WHY: two defects previously corrupted resume after a post-step escalation:
 *   A. completePhase only checkpointed when `phase.checkpoint === true`, so a
 *      workflow whose phase 1 completed (no flag) and phase 2 blocked resumed
 *      from the initial checkpoint and RE-EXECUTED phase 1's side effects.
 *   B. the post-step escalation branch in runPhase saved NO positional
 *      checkpoint (unlike the supervision-escalate path), so resume re-ran the
 *      already-succeeded actions of the in-progress phase.
 *
 * These tests pin the fixed behaviour: checkpointing is always-on per phase,
 * and a mid-phase escalation records currentPhase + currentActionIndex so
 * resume never re-executes completed work.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import { createMockReasoner } from "../../src/ports/mock-reasoner";
import { taskId, checkpointId } from "../../src/shared/id";
import { initialRiskState, initialTrust } from "../../src/governance";
import { snapshotToJson, snapshotFromJson } from "../../src/state-space/task-state";
import type { TaskStateSnapshot } from "../../src/state-space/types";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("workflow resume after a post-step escalation", () => {
  it("does not re-execute a completed phase (no checkpoint flag) when a later phase escalates post-step", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });

    let aCount = 0;
    let slowCount = 0;
    const a = delta.action({
      name: "a",
      description: "side-effectful phase-1 step",
      schema: z.object({}),
      fn: async () => {
        aCount++;
        return Ok("a-ok");
      },
    });
    // Succeeds, but blows the duration budget — post-step governance escalates
    // on a SUCCESSFUL action (budget-violation), which supervision never sees.
    const slow = delta.action({
      name: "slow",
      description: "succeeds while exhausting the duration budget",
      schema: z.object({}),
      fn: async () => {
        slowCount++;
        await sleep(400);
        return Ok("slow-ok");
      },
    });

    // Phase 1 deliberately declares checkpoint: false — checkpointing must be
    // always-on regardless, or resume re-runs phase 1's side effects.
    const p1 = { name: "p1", description: "first", actions: ["a"], checkpoint: false };
    const p2 = { name: "p2", description: "second", actions: ["slow"], checkpoint: false };
    const wf = delta.workflow({ name: "esc-wf", description: "escalates mid-run", version: "1.0.0", phases: [p1, p2] });
    delta.deploy(delta.agent({ name: "esc-agent", description: "d", role: "r", rolePrompt: ".", actions: [a, slow], workflows: [wf] }));

    const blocked = await delta.send({
      goal: "run both phases",
      agentName: "esc-agent",
      workflow: "esc-wf",
      budget: { tokens: 10_000, durationMs: 150 },
    });
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk) return;
    expect(blocked.value.status).toBe("blocked");
    expect(blocked.value.reason).toMatch(/escalated/);
    expect(aCount).toBe(1);
    expect(slowCount).toBe(1); // slow SUCCEEDED before the escalation fired

    // The escalation checkpoint records the position past slow (it succeeded).
    const ckpt = await store.getLatestCheckpoint(blocked.value.taskId);
    expect(ckpt.isOk).toBe(true);
    if (ckpt.isOk && ckpt.value !== null) {
      const state = snapshotFromJson(ckpt.value.state);
      expect(state.currentPhase).toBe("p2");
      expect(state.currentActionIndex).toBe(1);
      expect(state.completedPhases).toContain("p1");
    }

    const resumed = await delta.resume(blocked.value.taskId);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    // Neither the completed phase nor the already-succeeded action re-ran.
    expect(aCount).toBe(1);
    expect(slowCount).toBe(1);
  });

  it("re-enters an escalated phase AFTER the action that succeeded, then completes on resume", async () => {
    const store = createInMemoryStore();
    const delta = await createDeltaEngine({ store, reasoner: createMockReasoner({ responses: [] }) });

    let firstCount = 0;
    let secondCount = 0;
    const first = delta.action({
      name: "first",
      description: "side-effectful first action",
      schema: z.object({}),
      fn: async () => {
        firstCount++;
        return Ok("first-ok");
      },
    });
    const second = delta.action({
      name: "second",
      description: "second action of the same phase",
      schema: z.object({}),
      fn: async () => {
        secondCount++;
        return Ok("second-ok");
      },
    });
    const phase = { name: "only", description: "two actions", actions: ["first", "second"], checkpoint: false };
    const wf = delta.workflow({ name: "mid-wf", description: "escalates after first", version: "1.0.0", phases: [phase] });
    delta.deploy(delta.agent({ name: "mid-agent", description: "d", role: "r", rolePrompt: ".", actions: [first, second], workflows: [wf] }));

    // Seed a paused workflow task whose checkpointed Kalman estimate is very low
    // (0.1). The first successful action observes health ~1.0, so Bayesian
    // surprise (|0.1 - 1.0| / 0.1, capped at 1) crosses the 0.7 escalation
    // threshold deterministically — a post-step escalation on a SUCCESSFUL step.
    const id = taskId();
    const past = new Date(Date.now() - 60_000);
    const budget = { tokens: 10_000, durationMs: 300_000 };
    await store.saveTask({
      id, rootId: id, status: "paused", goal: "run the phase", assignedAgent: "mid-agent",
      workflow: "mid-wf", budget, risk: initialRiskState(), trust: initialTrust(), createdAt: past, updatedAt: past,
    });
    const seeded: TaskStateSnapshot = {
      taskId: id, rootId: id, agentName: "mid-agent", status: "paused",
      completedActions: [], completedWorkflows: [],
      budget, spent: { tokens: 0, durationMs: 0 },
      risk: initialRiskState(),
      // Extra headroom over the initial 0.5 so the surprise-driven trust decay
      // does not also trip the trust-degradation escalation on the next step.
      trust: { score: 0.6, successfulExecutions: 3, failedExecutions: 0, surpriseEvents: 0 },
      kalman: { estimate: 0.1, errorVariance: 0.5 },
      currentWorkflow: "mid-wf",
    };
    await store.saveCheckpoint({ id: checkpointId(), taskId: id, state: snapshotToJson(seeded), createdAt: past });

    const blocked = await delta.resume(id);
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk) return;
    expect(blocked.value.status).toBe("blocked");
    expect(blocked.value.reason).toMatch(/escalated/);
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0); // escalated before the second action ran

    // The mid-phase escalation checkpoint points at the NEXT action, not the top.
    const ckpt = await store.getLatestCheckpoint(id);
    expect(ckpt.isOk).toBe(true);
    if (ckpt.isOk && ckpt.value !== null) {
      const state = snapshotFromJson(ckpt.value.state);
      expect(state.currentPhase).toBe("only");
      expect(state.currentActionIndex).toBe(1);
    }

    const resumed = await delta.resume(id);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    // first was NOT re-executed; the phase resumed at second and completed.
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });
});
