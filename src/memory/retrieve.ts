/**
 * On-demand memory retrieval and writing (spec principle 4).
 *
 * retrieveContext pulls a small, relevance-ranked slice of an agent's memory and
 * formats it into the `ReasonerInput.context` string the reasoner sees before it
 * decides. It fetches a recent candidate pool from the store, then ranks in-app
 * (no vector index assumed) — keeping the store query simple and the ranking pure
 * and testable.
 *
 * makeContextRemember builds the `ctx.remember` helper the engine threads onto the
 * ActionContext, so an action fn, hook, or workflow phase can persist a memory.
 * Every write is attributable to the TaskID it was created in (invariant 8) and
 * owned by the agent (so a later task by the same agent can retrieve it).
 */

import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import type { Memory } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import { memoryId } from "../shared/id";
import { rankMemories } from "./rank";

export type RetrievedContext = {
  /** Formatted context string for ReasonerInput.context (empty when nothing relevant). */
  context: string;
  /** The memories that were selected, for diagnostics/tests. */
  memories: Memory[];
};

const DEFAULT_LIMIT = 5;
const DEFAULT_CANDIDATE_POOL = 100;

/**
 * Retrieve the most relevant memories for an agent given a query (typically the
 * task goal) and format them for the reasoner. Never throws and never fails the
 * caller: a store error or empty memory yields empty context (retrieval is a
 * best-effort enhancement, not a gate).
 */
export const retrieveContext = async ({
  store,
  agentName,
  query,
  limit = DEFAULT_LIMIT,
  candidatePool = DEFAULT_CANDIDATE_POOL,
}: {
  store: StoragePort;
  agentName: string;
  query: string;
  limit?: number;
  candidatePool?: number;
}): Promise<RetrievedContext> => {
  const result = await store.getMemoriesByAgent(agentName, candidatePool);
  if (result.isErr || result.value.length === 0) return { context: "", memories: [] };

  const top = rankMemories({ memories: result.value, query, limit });
  const context = top.map((m) => `- (${m.kind}) ${m.content}`).join("\n");
  return { context, memories: top };
};

/**
 * Build the `ctx.remember(content, kind?)` helper bound to a task + agent.
 * Persists a Memory; returns Err only if the store write fails.
 */
export const makeContextRemember = ({
  store,
  taskId,
  agentName,
}: {
  store: StoragePort;
  taskId: string;
  agentName: string;
}): ((content: string, kind?: string) => Promise<Result<unknown, string>>) =>
  async (content, kind = "note") => {
    const memory: Memory = { id: memoryId(), taskId, agentName, kind, content, createdAt: new Date() };
    const saved = await store.saveMemory(memory);
    return saved.isOk ? Ok(undefined) : Err(saved.error);
  };
