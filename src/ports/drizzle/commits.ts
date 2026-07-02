import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq, desc, and, like } from "drizzle-orm";
import type { Commit, CommitQuery } from "../../shared/types";
import { commits } from "../../../db/models/schema";
import type { DB } from "./db";
import { toCommit } from "./converters";

// ── Commits ──────────────────────────────────────────────────────────────

export const commitMethods = (db: DB) => ({
  saveCommit: async (commit: Commit): Promise<Result<Commit, string>> => {
    try {
      await db.insert(commits).values({
        id:           commit.id,
        taskId:       commit.taskId,
        agentName:    commit.agentName,
        workflowName: commit.workflowName,
        notes:        commit.notes,
        checkpointId: commit.checkpointId,
        createdAt:    commit.createdAt.getTime(),
      });
      return Ok(commit);
    } catch (e) {
      return Err(`failed to save commit "${commit.id}": ${String(e)}`);
    }
  },

  getCommitsByAgent: async (agentName: string, limit?: number): Promise<Result<Commit[], string>> => {
    try {
      const base = db.select().from(commits).where(eq(commits.agentName, agentName)).orderBy(desc(commits.createdAt));
      const rows = limit !== undefined ? await base.limit(limit) : await base;
      return Ok(rows.map(toCommit));
    } catch (e) {
      return Err(`failed to get commits for agent "${agentName}": ${String(e)}`);
    }
  },

  searchCommits: async (query: CommitQuery, currentAgent: string): Promise<Result<Commit[], string>> => {
    try {
      const conditions = [];
      if (query.allAgents !== true) conditions.push(eq(commits.agentName, currentAgent));
      if (query.workflowName !== undefined) conditions.push(eq(commits.workflowName, query.workflowName));
      if (query.query !== undefined) conditions.push(like(commits.notes, `%${query.query}%`));
      const base = db.select().from(commits);
      const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
      const rows = await filtered.orderBy(desc(commits.createdAt)).limit(query.limit ?? 20);
      return Ok(rows.map(toCommit));
    } catch (e) {
      return Err(`failed to search commits: ${String(e)}`);
    }
  },
});
