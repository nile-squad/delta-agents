/**
 * Scoped ID generation for all delta-agents runtime objects.
 *
 * nanoid generates cryptographically random, URL-safe IDs (default 21 chars,
 * ~10^32 combinations). This matters because TaskID is the security boundary:
 * an agent that cannot guess a TaskID cannot forge authorization, invoke a
 * capability outside its scope, or access another task's audit trail.
 * Agents retrieve their own task IDs through the engine, never by inference.
 *
 * Prefixes (e.g. "tsk_", "exc_") make IDs self-describing in logs and audit
 * trails so misidentification across domain boundaries is immediately visible.
 */

import { nanoid } from "nanoid";

const generateId = (prefix: string): string => `${prefix}${nanoid()}`;

export const taskId = (): string => generateId("tsk_");
export const executionId = (): string => generateId("exc_");
export const checkpointId = (): string => generateId("ckpt_");
export const approvalId = (): string => generateId("appr_");
export const messageId = (): string => generateId("msg_");
export const queueId = (): string => generateId("que_");
