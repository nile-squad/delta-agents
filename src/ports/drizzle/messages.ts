import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq, and, lt } from "drizzle-orm";
import type { Message } from "../../shared/types";
import { messages } from "../../../db/models/schema";
import type { DB } from "./db";
import { toMessage } from "./converters";

// ── Messages ─────────────────────────────────────────────────────────────

export const messageMethods = (db: DB) => ({
  saveMessage: async (msg: Message): Promise<Result<Message, string>> => {
    try {
      await db.insert(messages).values({
        id:        msg.id,
        taskId:    msg.taskId,
        sender:    msg.sender,
        receiver:  msg.receiver,
        payload:   JSON.stringify(msg.payload),
        createdAt: msg.createdAt.getTime(),
        consumed:  msg.consumed ? 1 : 0,
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

  markMessageConsumed: async (id: string): Promise<Result<void, string>> => {
    try {
      await db.update(messages).set({ consumed: 1 }).where(eq(messages.id, id));
      return Ok(undefined);
    } catch (e) {
      return Err(`failed to mark message "${id}" consumed: ${String(e)}`);
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
