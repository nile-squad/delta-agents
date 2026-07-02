import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq, desc } from "drizzle-orm";
import type { Memory } from "../../shared/types";
import { memories } from "../../../db/models/schema";
import type { DB } from "./db";
import { toMemory } from "./converters";

// ── Memories ─────────────────────────────────────────────────────────────

export const memoryMethods = (db: DB) => ({
  saveMemory: async (memory: Memory): Promise<Result<Memory, string>> => {
    try {
      await db.insert(memories).values({
        id:        memory.id,
        taskId:    memory.taskId,
        agentName: memory.agentName,
        kind:      memory.kind,
        content:   memory.content,
        createdAt: memory.createdAt.getTime(),
      });
      return Ok(memory);
    } catch (e) {
      return Err(`failed to save memory "${memory.id}": ${String(e)}`);
    }
  },

  getMemoriesByAgent: async (agentName: string, limit?: number): Promise<Result<Memory[], string>> => {
    try {
      const base = db.select().from(memories).where(eq(memories.agentName, agentName)).orderBy(desc(memories.createdAt));
      const rows = limit !== undefined ? await base.limit(limit) : await base;
      return Ok(rows.map(toMemory));
    } catch (e) {
      return Err(`failed to get memories for agent "${agentName}": ${String(e)}`);
    }
  },
});
