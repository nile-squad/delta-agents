/**
 * Workflow resume tests (#2).
 *
 * WHY: resumeTask previously re-entered every task through the free reasoner
 * loop (runSendLoop), so a paused *workflow* task dropped into the wrong engine
 * on resume and the deterministic phases never ran. These tests pin the fixed
 * behaviour:
 *
 *   1. A paused workflow task resumes through the workflow engine, not the
 *      reasoner. The reasoner has no responses, so if resume routed to the
 *      reasoner loop the workflow action would never run and the assertion fails.
 *   2. A workflow that escalated after phase 1 resumes WITHOUT re-running phase 1
 *      (mid-workflow resume): completed phases are skipped from the checkpoint, so
 *      side-effectful phases do not double-execute.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createMockReasoner } from "../../src/ports/mock-reasoner";

describe("workflow resume: routes through the workflow engine (#2)", () => {
  it("resumes an approval-blocked workflow task to completion via the workflow path", async () => {
    // The reasoner is given NO responses: a workflow task must not consult it.
    // If resume wrongly used the reasoner loop, `ran` would stay empty.
    const delta = await createDeltaEngine({ reasoner: createMockReasoner({ responses: [] }) });

    const ran: string[] = [];
    const step = delta.action({
      name: "step",
      description: "a governed step that needs sign-off",
      schema: z.object({}),
      requiresApproval: true,
      fn: async () => {
        ran.push("ran");
        return Ok("done");
      },
    });
    const phase = { name: "only", description: "single phase", actions: ["step"], checkpoint: true };
    const wf = delta.workflow({ name: "approve-wf", description: "needs approval", version: "1.0.0", phases: [phase] });
    const agent = delta.agent({
      name: "wf-agent",
      description: "runs a workflow",
      role: "R",
      rolePrompt: ".",
      actions: [step],
      workflows: [wf],
    });
    delta.deploy(agent);

    const blocked = await delta.send({ goal: "do it", agentName: "wf-agent", workflow: "approve-wf" });
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk) return;
    expect(blocked.value.status).toBe("blocked");
    expect(ran).toEqual([]); // nothing ran yet; the approval pre-flight blocked

    const taskId = blocked.value.taskId;

    // The pending approval id is on the audit surface, not the block message.
    const inspected = await delta.inspect(taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    const approvalId = inspected.value.pendingApprovals[0]?.id;
    expect(approvalId).toBeDefined();
    if (approvalId === undefined) return;

    await delta.approve(approvalId);

    const resumed = await delta.resume(taskId);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    // Completed through the deterministic workflow engine, and the action ran
    // exactly once: proof the resume used the workflow path, not the reasoner.
    expect(resumed.value.status).toBe("completed");
    expect(ran).toEqual(["ran"]);
  });

  it("re-enters an escalated phase at the failed action, not its first action (mid-phase resume)", async () => {
    const delta = await createDeltaEngine({ reasoner: createMockReasoner({ responses: [] }) });

    let aCount = 0;
    let flakyCalls = 0;
    const a = delta.action({
      name: "a",
      description: "side-effectful first action of the phase",
      schema: z.object({}),
      fn: async () => {
        aCount++;
        return Ok("a-ok");
      },
    });
    const flaky = delta.action({
      name: "flaky",
      description: "fails once then succeeds",
      schema: z.object({}),
      fn: async () => {
        flakyCalls++;
        return flakyCalls === 1 ? Err("flaky-fail") : Ok("flaky-ok");
      },
    });
    // One phase, two actions: [a, flaky]. It escalates after a succeeds and flaky fails.
    const phase = {
      name: "two-step",
      description: "two actions, escalates on failure",
      actions: ["a", "flaky"],
      checkpoint: true,
      supervision: { strategy: "escalate" as const, maxRetries: 0 },
    };
    const wf = delta.workflow({ name: "single-phase", description: "one phase", version: "1.0.0", phases: [phase] });
    const agent = delta.agent({
      name: "mp-agent",
      description: "single phase, two actions",
      role: "R",
      rolePrompt: ".",
      actions: [a, flaky],
      workflows: [wf],
    });
    delta.deploy(agent);

    const blocked = await delta.send({ goal: "run the phase", agentName: "mp-agent", workflow: "single-phase" });
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk) return;
    expect(blocked.value.status).toBe("blocked"); // escalated mid-phase
    expect(aCount).toBe(1); // a ran
    expect(flakyCalls).toBe(1); // flaky attempted and failed

    const resumed = await delta.resume(blocked.value.taskId);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    // a was NOT re-run: the phase resumed at the failed action (flaky), not the top.
    expect(aCount).toBe(1);
    // flaky re-ran and succeeded.
    expect(flakyCalls).toBe(2);
  });

  it("skips an already-completed phase on resume (mid-workflow resume)", async () => {
    const delta = await createDeltaEngine({ reasoner: createMockReasoner({ responses: [] }) });

    let aCount = 0;
    let flakyCalls = 0;
    const a = delta.action({
      name: "a",
      description: "side-effectful phase-1 step",
      schema: z.object({}),
      fn: async () => {
        aCount++;
        return Ok("a-ok");
      },
    });
    const flaky = delta.action({
      name: "flaky",
      description: "fails once then succeeds",
      schema: z.object({}),
      fn: async () => {
        flakyCalls++;
        return flakyCalls === 1 ? Err("flaky-fail") : Ok("flaky-ok");
      },
    });

    const p1 = { name: "p1", description: "first", actions: ["a"], checkpoint: true };
    // p2 escalates on failure, which pauses the task after p1 has completed.
    const p2 = {
      name: "p2",
      description: "second",
      actions: ["flaky"],
      checkpoint: true,
      supervision: { strategy: "escalate" as const, maxRetries: 0 },
    };
    const wf = delta.workflow({ name: "two-phase", description: "ordered", version: "1.0.0", phases: [p1, p2] });
    const agent = delta.agent({
      name: "mw-agent",
      description: "two phase workflow",
      role: "R",
      rolePrompt: ".",
      actions: [a, flaky],
      workflows: [wf],
    });
    delta.deploy(agent);

    const blocked = await delta.send({ goal: "run both", agentName: "mw-agent", workflow: "two-phase" });
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk) return;
    expect(blocked.value.status).toBe("blocked"); // p2 escalated
    expect(aCount).toBe(1); // p1 ran once
    expect(flakyCalls).toBe(1); // p2 attempted once and failed

    const resumed = await delta.resume(blocked.value.taskId);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    expect(resumed.value.status).toBe("completed");
    // p1 was NOT re-run; its checkpoint marked it complete, so resume skipped it.
    expect(aCount).toBe(1);
    // p2 re-ran and succeeded on the second attempt.
    expect(flakyCalls).toBe(2);
  });
});
