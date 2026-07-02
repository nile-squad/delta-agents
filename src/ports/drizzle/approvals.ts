import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq } from "drizzle-orm";
import type { ApprovalRequest } from "../../shared/types";
import { approvalRequests } from "../../../db/models/schema";
import type { DB } from "./db";
import { toApprovalRequest } from "./converters";

// ── Approvals ────────────────────────────────────────────────────────────

export const approvalMethods = (db: DB) => ({
  saveApprovalRequest: async (req: ApprovalRequest): Promise<Result<ApprovalRequest, string>> => {
    try {
      await db.insert(approvalRequests).values({
        id:        req.id,
        taskId:    req.taskId,
        action:    req.action,
        reason:    req.reason,
        status:    req.status,
        createdAt: req.createdAt.getTime(),
      });
      return Ok(req);
    } catch (e) {
      return Err(`failed to save approval request "${req.id}": ${String(e)}`);
    }
  },

  getApprovalRequest: async (id: string): Promise<Result<ApprovalRequest, string>> => {
    try {
      const rows = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
      const row = rows[0];
      if (!row) return Err(`approval request "${id}" not found`);
      return Ok(toApprovalRequest(row));
    } catch (e) {
      return Err(`failed to get approval request "${id}": ${String(e)}`);
    }
  },

  updateApprovalRequest: async (id: string, patch: Partial<ApprovalRequest>): Promise<Result<ApprovalRequest, string>> => {
    try {
      const vals: Record<string, unknown> = {};
      if (patch.status !== undefined) vals["status"] = patch.status;

      await db.update(approvalRequests).set(vals).where(eq(approvalRequests.id, id));

      const rows = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
      const row = rows[0];
      if (!row) return Err(`approval request "${id}" not found after update`);
      return Ok(toApprovalRequest(row));
    } catch (e) {
      return Err(`failed to update approval request "${id}": ${String(e)}`);
    }
  },

  getPendingApprovals: async (taskId: string): Promise<Result<ApprovalRequest[], string>> => {
    try {
      const rows = await db.select().from(approvalRequests)
        .where(eq(approvalRequests.taskId, taskId));
      return Ok(rows.filter((r) => r.status === "pending").map(toApprovalRequest));
    } catch (e) {
      return Err(`failed to get pending approvals for task "${taskId}": ${String(e)}`);
    }
  },

  getApprovalsByTask: async (taskId: string): Promise<Result<ApprovalRequest[], string>> => {
    try {
      const rows = await db.select().from(approvalRequests)
        .where(eq(approvalRequests.taskId, taskId));
      return Ok(rows.map(toApprovalRequest));
    } catch (e) {
      return Err(`failed to get approvals for task "${taskId}": ${String(e)}`);
    }
  },
});
