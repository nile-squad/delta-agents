import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq } from "drizzle-orm";
import type { EscalationRecord } from "../../shared/types";
import { escalations } from "../../../db/models/schema";
import type { DB } from "./db";
import { toEscalationRecord } from "./converters";

// ── Escalations ──────────────────────────────────────────────────────────

export const escalationMethods = (db: DB) => ({
  saveEscalation: async (record: EscalationRecord): Promise<Result<EscalationRecord, string>> => {
    try {
      await db.insert(escalations).values({
        id:        record.id,
        taskId:    record.taskId,
        trigger:   record.trigger,
        reason:    record.reason,
        createdAt: record.createdAt.getTime(),
      });
      return Ok(record);
    } catch (e) {
      return Err(`failed to save escalation "${record.id}": ${String(e)}`);
    }
  },

  getEscalationsByTask: async (taskId: string): Promise<Result<EscalationRecord[], string>> => {
    try {
      const rows = await db.select().from(escalations).where(eq(escalations.taskId, taskId));
      return Ok(rows.map(toEscalationRecord));
    } catch (e) {
      return Err(`failed to get escalations for task "${taskId}": ${String(e)}`);
    }
  },
});
