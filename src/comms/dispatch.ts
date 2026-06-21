/**
 * Channel dispatch — the single path every outbound message flows through,
 * whether triggered by the reasoner (`kind: "communicate"`) or declaratively by
 * a hook / workflow phase. Centralising it is a governance property, not just
 * DRY: a message is sent, approval-gated, and recorded identically regardless of
 * who triggered it, so a hook-sent message is exactly as audited as a
 * reasoner-sent one (invariant 9 — every message is TaskID-attributable).
 *
 * The pipeline:
 *   1. resolve the agent's enabled channel of the requested type,
 *   2. if the channel requires approval, gate on a human decision (auto-request
 *      a pending approval and block until resolved — same machinery as actions),
 *   3. call channel.sendMessage (the Chat SDK transport, behind the interface),
 *   4. record a TaskID-attributable Message of what was sent.
 */

import type { Result } from "slang-ts";
import type { Agent, ActionContext, ChannelType } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { StoragePort } from "../ports/storage-port";
import type { Message } from "../shared/types";
import { getApprovalStatusForAction, requestApproval } from "../oversight";
import { executionId, messageId } from "../shared/id";

/** Synthetic approval key for a channel so outbound comms reuse the action approval store. */
const channelApprovalKey = (channelType: string): string => `channel:${channelType}`;

export type CommunicationOutcome =
  // The message was sent and recorded.
  | { kind: "sent"; message: Message }
  // The channel requires human sign-off; a pending approval has been recorded.
  | { kind: "approval-required"; reason: string }
  // Could not send (no such channel, transport error, rejected approval).
  | { kind: "failed"; reason: string };

/**
 * Resolve, govern, send, and record one outbound message. Pure of scheduling
 * concerns — the caller decides what a "blocked"/"failed" outcome means for the
 * task lifecycle.
 */
export const dispatchCommunication = async ({
  agent,
  channelType,
  body,
  snapshot,
  store,
}: {
  agent: Agent;
  channelType: string;
  body: string;
  snapshot: TaskStateSnapshot;
  store: StoragePort;
}): Promise<CommunicationOutcome> => {
  const channel = (agent.channels ?? []).find((c) => c.type === channelType && c.enabled);
  if (channel === undefined) {
    return { kind: "failed", reason: `no enabled channel of type "${channelType}" on agent "${agent.name}"` };
  }

  const taskId = snapshot.taskId;

  // ── Approval gate (channel-level) ───────────────────────────────────────
  if (channel.requiresApproval === true) {
    const statusResult = await getApprovalStatusForAction({ taskId, action: channelApprovalKey(channelType), store });
    const status = statusResult.isOk ? statusResult.value : "none";

    if (status === "rejected") {
      return { kind: "failed", reason: `communication on channel "${channelType}" was rejected by a human reviewer` };
    }
    if (status !== "approved") {
      if (status === "none") {
        const req = await requestApproval({
          taskId,
          action: channelApprovalKey(channelType),
          reason: `message on channel "${channelType}" requires human approval before sending`,
          store,
        });
        const id = req.isOk ? req.value.id : "(unavailable)";
        return { kind: "approval-required", reason: `approval-required: channel "${channelType}" needs human sign-off — approval id: ${id}` };
      }
      return { kind: "approval-required", reason: `approval-required: channel "${channelType}" approval is pending human resolution` };
    }
  }

  // ── Send (transport behind the interface) ───────────────────────────────
  const ctx: ActionContext = {
    taskId,
    executionId: executionId(),
    agentName: snapshot.agentName,
    phase: snapshot.currentPhase,
  };
  const sendResult: Result<unknown, string> = await channel.sendMessage(body, ctx);
  if (sendResult.isErr) {
    return { kind: "failed", reason: `channel "${channelType}" send failed: ${sendResult.error}` };
  }

  // ── Record the message (audit, invariant 9) ─────────────────────────────
  const message: Message = {
    id: messageId(),
    taskId,
    sender: snapshot.agentName,
    receiver: channelType as ChannelType,
    payload: body,
    createdAt: new Date(),
  };
  await store.saveMessage(message);

  return { kind: "sent", message };
};
