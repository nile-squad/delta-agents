import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq, and, lt, isNull, asc } from "drizzle-orm";
import type { Message } from "../../shared/types";
import { messages } from "../../../db/models/schema";
import type { DB } from "./db";
import { toMessage } from "./converters";

// ── Messages ─────────────────────────────────────────────────────────────

export const messageMethods = (db: DB) => ({
  saveMessage: async (msg: Message): Promise<Result<Message, string>> => {
    try {
      await db.insert(messages).values({
        id:          msg.id,
        taskId:      msg.taskId,
        sender:      msg.sender,
        receiver:    msg.receiver,
        payload:     JSON.stringify(msg.payload),
        createdAt:   msg.createdAt.getTime(),
        consumed:    msg.consumed ? 1 : 0,
        deliveredAt: msg.deliveredAt?.getTime() ?? null,
        readAt:      msg.readAt?.getTime() ?? null,
        recalledAt:  msg.recalledAt?.getTime() ?? null,
      });
      return Ok(msg);
    } catch (e) {
      return Err(`failed to save message "${msg.id}": ${String(e)}`);
    }
  },

  getMessages: async (taskId: string): Promise<Result<Message[], string>> => {
    try {
      const rows = await db.select().from(messages).where(eq(messages.taskId, taskId));
      return Ok(rows.map(toMessage));
    } catch (e) {
      return Err(`failed to get messages for task "${taskId}": ${String(e)}`);
    }
  },

  getMessagesByReceiver: async (receiver: string): Promise<Result<Message[], string>> => {
    try {
      const rows = await db.select().from(messages).where(eq(messages.receiver, receiver));
      return Ok(rows.map(toMessage));
    } catch (e) {
      return Err(`failed to get messages for receiver "${receiver}": ${String(e)}`);
    }
  },

  getMessagesBySender: async (sender: string): Promise<Result<Message[], string>> => {
    try {
      const rows = await db.select().from(messages).where(eq(messages.sender, sender));
      return Ok(rows.map(toMessage));
    } catch (e) {
      return Err(`failed to get messages for sender "${sender}": ${String(e)}`);
    }
  },

  markMessageConsumed: async (id: string): Promise<Result<void, string>> => {
    try {
      await db.update(messages).set({ consumed: 1 }).where(eq(messages.id, id));
      return Ok(undefined);
    } catch (e) {
      return Err(`failed to mark message "${id}" consumed: ${String(e)}`);
    }
  },

  markMessageRead: async (id: string, at: Date): Promise<Result<void, string>> => {
    try {
      // Read stamps the receipt and, if never surfaced, the delivery time too;
      // consumed stays in lockstep for backward-compatible mention dedup. Only
      // fills readAt/deliveredAt when still null so the call is idempotent.
      const rows = await db.select().from(messages).where(eq(messages.id, id));
      const row = rows[0];
      if (!row) return Err(`message "${id}" not found`);
      await db.update(messages).set({
        consumed: 1,
        deliveredAt: row.deliveredAt ?? at.getTime(),
        readAt: row.readAt ?? at.getTime(),
      }).where(eq(messages.id, id));
      return Ok(undefined);
    } catch (e) {
      return Err(`failed to mark message "${id}" read: ${String(e)}`);
    }
  },

  recallMessage: async (id: string): Promise<Result<Message, string>> => {
    try {
      const rows = await db.select().from(messages).where(eq(messages.id, id));
      const row = rows[0];
      if (!row) return Err(`message "${id}" not found`);
      if (row.readAt !== null && row.readAt !== undefined) return Err(`message "${id}" was already read — cannot recall`);
      if (row.recalledAt !== null && row.recalledAt !== undefined) return Err(`message "${id}" was already recalled`);
      const recalledAt = Date.now();
      await db.update(messages).set({ recalledAt }).where(eq(messages.id, id));
      return Ok(toMessage({ ...row, recalledAt }));
    } catch (e) {
      return Err(`failed to recall message "${id}": ${String(e)}`);
    }
  },

  evictReadMessages: async (receiver: string, cap: number): Promise<Result<number, string>> => {
    try {
      // Count non-recalled messages for the receiver; only prune the overage, and
      // only READ ones, oldest first. Unread messages are never evicted.
      const live = await db.select().from(messages)
        .where(and(eq(messages.receiver, receiver), isNull(messages.recalledAt)))
        .orderBy(asc(messages.createdAt));
      if (live.length <= cap) return Ok(0);
      // Only READ rows are eviction candidates, oldest first (the scan is already
      // ordered by createdAt asc).
      const readIds = live
        .filter((r) => r.readAt !== null && r.readAt !== undefined)
        .map((r) => r.id);
      const toRemove = Math.min(live.length - cap, readIds.length);
      let removed = 0;
      for (const id of readIds.slice(0, toRemove)) {
        await db.delete(messages).where(eq(messages.id, id));
        removed += 1;
      }
      return Ok(removed);
    } catch (e) {
      return Err(`failed to evict read messages for receiver "${receiver}": ${String(e)}`);
    }
  },

  deleteMessages: async (taskId: string, olderThan?: Date): Promise<Result<number, string>> => {
    try {
      // Only CONSUMED messages are pruned; unconsumed mentions may still need
      // delivery. `olderThan` further restricts to consumed messages created
      // before that date.
      const whereClause = olderThan !== undefined
        ? and(eq(messages.taskId, taskId), eq(messages.consumed, 1), lt(messages.createdAt, olderThan.getTime()))
        : and(eq(messages.taskId, taskId), eq(messages.consumed, 1));
      const result = await db.delete(messages).where(whereClause);
      return Ok(Number(result.rowsAffected));
    } catch (e) {
      return Err(`failed to delete messages for task "${taskId}": ${String(e)}`);
    }
  },
});
