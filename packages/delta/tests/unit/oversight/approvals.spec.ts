/**
 * Approval lifecycle unit tests.
 *
 * requestApproval creates a pending record; resolveApproval transitions it to
 * approved or rejected; getApprovalStatusForAction bridges the record to the
 * ApprovalStatus type the execution gateway consumes.
 *
 * A rejected approval blocks the gateway — the engine never silently re-opens
 * a rejection (prohibition 11). Approval records are TaskID-attributable so
 * every human decision is auditable (invariant 13).
 */

import { describe, it, expect } from "vitest";
import {
  requestApproval,
  resolveApproval,
  getApproval,
  getApprovalStatusForAction,
} from "../../../src/oversight";
import { createInMemoryStore } from "../../../src/ports";

// ── requestApproval ───────────────────────────────────────────────────────────

describe("requestApproval — create a pending approval request", () => {
  it("creates an approval with status 'pending'", async () => {
    const store = createInMemoryStore();
    const result = await requestApproval({
      taskId: "tsk_1",
      action: "send-email",
      reason: "sends external email",
      store,
    });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.status).toBe("pending");
  });

  it("stores the correct taskId, action, and reason", async () => {
    const store = createInMemoryStore();
    const result = await requestApproval({
      taskId: "tsk_abc",
      action: "process-payment",
      reason: "irreversible financial action",
      store,
    });
    if (result.isOk) {
      expect(result.value.taskId).toBe("tsk_abc");
      expect(result.value.action).toBe("process-payment");
      expect(result.value.reason).toBe("irreversible financial action");
    }
  });

  it("generates a unique id for each request (invariant 13 — auditable)", async () => {
    const store = createInMemoryStore();
    const r1 = await requestApproval({ taskId: "tsk_1", action: "act", reason: "r", store });
    const r2 = await requestApproval({ taskId: "tsk_1", action: "act", reason: "r", store });
    if (r1.isOk && r2.isOk) expect(r1.value.id).not.toBe(r2.value.id);
  });

  it("includes an id prefixed with 'appr_'", async () => {
    const store = createInMemoryStore();
    const result = await requestApproval({ taskId: "tsk_1", action: "a", reason: "r", store });
    if (result.isOk) expect(result.value.id.startsWith("appr_")).toBe(true);
  });

  it("persists the request so getApproval can retrieve it", async () => {
    const store = createInMemoryStore();
    const created = await requestApproval({ taskId: "tsk_1", action: "a", reason: "r", store });
    if (created.isOk) {
      const fetched = await getApproval({ approvalId: created.value.id, store });
      expect(fetched.isOk).toBe(true);
      if (fetched.isOk) expect(fetched.value.id).toBe(created.value.id);
    }
  });
});

// ── resolveApproval ───────────────────────────────────────────────────────────

describe("resolveApproval — approve or reject a pending request", () => {
  it("updates status to 'approved' on approve decision", async () => {
    const store = createInMemoryStore();
    const req = await requestApproval({ taskId: "tsk_1", action: "a", reason: "r", store });
    if (req.isOk) {
      const resolved = await resolveApproval({
        approvalId: req.value.id,
        decision: "approved",
        store,
      });
      expect(resolved.isOk).toBe(true);
      if (resolved.isOk) expect(resolved.value.status).toBe("approved");
    }
  });

  it("updates status to 'rejected' on reject decision (prohibition 11 path)", async () => {
    const store = createInMemoryStore();
    const req = await requestApproval({ taskId: "tsk_1", action: "a", reason: "r", store });
    if (req.isOk) {
      const resolved = await resolveApproval({
        approvalId: req.value.id,
        decision: "rejected",
        store,
      });
      expect(resolved.isOk).toBe(true);
      if (resolved.isOk) expect(resolved.value.status).toBe("rejected");
    }
  });

  it("persists the resolved status — getApproval reflects the decision", async () => {
    const store = createInMemoryStore();
    const req = await requestApproval({ taskId: "tsk_1", action: "a", reason: "r", store });
    if (req.isOk) {
      await resolveApproval({ approvalId: req.value.id, decision: "approved", store });
      const fetched = await getApproval({ approvalId: req.value.id, store });
      if (fetched.isOk) expect(fetched.value.status).toBe("approved");
    }
  });

  it("returns Err when the approval id does not exist", async () => {
    const store = createInMemoryStore();
    const result = await resolveApproval({
      approvalId: "appr_ghost",
      decision: "approved",
      store,
    });
    expect(result.isErr).toBe(true);
  });
});

// ── getApproval ───────────────────────────────────────────────────────────────

describe("getApproval — fetch by id", () => {
  it("returns the correct record", async () => {
    const store = createInMemoryStore();
    const req = await requestApproval({
      taskId: "tsk_99",
      action: "delete-record",
      reason: "irreversible deletion",
      store,
    });
    if (req.isOk) {
      const fetched = await getApproval({ approvalId: req.value.id, store });
      if (fetched.isOk) {
        expect(fetched.value.taskId).toBe("tsk_99");
        expect(fetched.value.action).toBe("delete-record");
      }
    }
  });

  it("returns Err when id is not found", async () => {
    const store = createInMemoryStore();
    const result = await getApproval({ approvalId: "appr_does_not_exist", store });
    expect(result.isErr).toBe(true);
  });
});

// ── getApprovalStatusForAction ────────────────────────────────────────────────

describe("getApprovalStatusForAction — bridge to gateway ApprovalStatus", () => {
  it("returns 'none' when no approval request exists for the action", async () => {
    const store = createInMemoryStore();
    const result = await getApprovalStatusForAction({
      taskId: "tsk_1",
      action: "no-approval-action",
      store,
    });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBe("none");
  });

  it("returns 'pending' when a pending approval exists", async () => {
    const store = createInMemoryStore();
    await requestApproval({ taskId: "tsk_1", action: "risky-action", reason: "r", store });

    const result = await getApprovalStatusForAction({
      taskId: "tsk_1",
      action: "risky-action",
      store,
    });
    if (result.isOk) expect(result.value).toBe("pending");
  });

  it("returns 'approved' after the approval is approved", async () => {
    const store = createInMemoryStore();
    const req = await requestApproval({
      taskId: "tsk_1",
      action: "risky-action",
      reason: "r",
      store,
    });
    if (req.isOk) {
      await resolveApproval({ approvalId: req.value.id, decision: "approved", store });
    }

    const result = await getApprovalStatusForAction({
      taskId: "tsk_1",
      action: "risky-action",
      store,
    });
    if (result.isOk) expect(result.value).toBe("approved");
  });

  it("returns 'rejected' after the approval is rejected (prohibition 11 — gate stays closed)", async () => {
    const store = createInMemoryStore();
    const req = await requestApproval({
      taskId: "tsk_1",
      action: "risky-action",
      reason: "r",
      store,
    });
    if (req.isOk) {
      await resolveApproval({ approvalId: req.value.id, decision: "rejected", store });
    }

    const result = await getApprovalStatusForAction({
      taskId: "tsk_1",
      action: "risky-action",
      store,
    });
    if (result.isOk) expect(result.value).toBe("rejected");
  });

  it("is scoped to taskId — another task's approval does not bleed over", async () => {
    const store = createInMemoryStore();
    // Approve for task A
    const req = await requestApproval({ taskId: "tsk_A", action: "shared-action", reason: "r", store });
    if (req.isOk) {
      await resolveApproval({ approvalId: req.value.id, decision: "approved", store });
    }

    // Task B has no approval
    const resultB = await getApprovalStatusForAction({
      taskId: "tsk_B",
      action: "shared-action",
      store,
    });
    if (resultB.isOk) expect(resultB.value).toBe("none");
  });

  it("returns the most recent approval when multiple requests exist for the same action", async () => {
    const store = createInMemoryStore();
    // First request — approved
    const r1 = await requestApproval({ taskId: "tsk_1", action: "act", reason: "first", store });
    if (r1.isOk) {
      await resolveApproval({ approvalId: r1.value.id, decision: "approved", store });
    }
    // Second request — pending (overrides the approved one)
    await requestApproval({ taskId: "tsk_1", action: "act", reason: "second", store });

    const result = await getApprovalStatusForAction({ taskId: "tsk_1", action: "act", store });
    if (result.isOk) expect(result.value).toBe("pending");
  });
});
