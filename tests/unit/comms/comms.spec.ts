/**
 * Channel dispatch + Chat SDK bridge unit tests.
 *
 * dispatchCommunication is the single path every outbound message flows through;
 * these tests cover the four outcomes (sent, no-channel, approval-gate, rejected)
 * and the Message audit record. createChatSdkChannel is the thin structural
 * bridge from a Chat SDK thread to a delta Channel.
 */

import { describe, it, expect } from "vitest";
import { Ok, Err } from "slang-ts";
import { dispatchCommunication, createChatSdkChannel } from "../../../src/comms";
import { createInMemoryStore } from "../../../src/ports";
import { requestApproval, resolveApproval } from "../../../src/oversight";
import { initialRiskState, initialTrust } from "../../../src/governance";
import type { Agent, Channel } from "../../../src/authoring";
import type { TaskStateSnapshot } from "../../../src/state-space";

const snapshot = (): TaskStateSnapshot => ({
  taskId: "tsk_comms",
  rootId: "tsk_comms",
  agentName: "comms-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 1_000, durationMs: 10_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: initialRiskState(),
  trust: initialTrust(),
});

const agentWith = (channels: Channel[]): Agent => ({
  name: "comms-agent",
  description: "d",
  role: "r",
  rolePrompt: ".",
  actions: [],
  channels,
});

describe("dispatchCommunication", () => {
  it("sends through the channel and records a TaskID-attributable Message", async () => {
    const store = createInMemoryStore();
    const sent: string[] = [];
    const agent = agentWith([
      { type: "slack", enabled: true, sendMessage: async (m) => { sent.push(m); return Ok(undefined); } },
    ]);

    const outcome = await dispatchCommunication({ agent, channelType: "slack", body: "hello", snapshot: snapshot(), store });
    expect(outcome.kind).toBe("sent");
    expect(sent).toEqual(["hello"]);

    const msgs = await store.getMessages("tsk_comms");
    if (msgs.isOk) {
      expect(msgs.value).toHaveLength(1);
      expect(msgs.value[0]?.sender).toBe("comms-agent");
      expect(msgs.value[0]?.receiver).toBe("slack");
      expect(msgs.value[0]?.payload).toBe("hello");
    }
  });

  it("fails when the agent has no enabled channel of that type", async () => {
    const store = createInMemoryStore();
    const agent = agentWith([
      { type: "slack", enabled: false, sendMessage: async () => Ok(undefined) },
    ]);
    const outcome = await dispatchCommunication({ agent, channelType: "slack", body: "x", snapshot: snapshot(), store });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toMatch(/no enabled channel/);
  });

  it("blocks (approval-required) and does not send when the channel requires approval", async () => {
    const store = createInMemoryStore();
    const sent: string[] = [];
    const agent = agentWith([
      { type: "email", enabled: true, requiresApproval: true, sendMessage: async (m) => { sent.push(m); return Ok(undefined); } },
    ]);
    const outcome = await dispatchCommunication({ agent, channelType: "email", body: "invoice", snapshot: snapshot(), store });
    expect(outcome.kind).toBe("approval-required");
    expect(sent).toEqual([]);

    const approvals = await store.getPendingApprovals("tsk_comms");
    if (approvals.isOk) expect(approvals.value.some((a) => a.action === "channel:email")).toBe(true);
  });

  it("sends once the channel approval is granted", async () => {
    const store = createInMemoryStore();
    const sent: string[] = [];
    const agent = agentWith([
      { type: "email", enabled: true, requiresApproval: true, sendMessage: async (m) => { sent.push(m); return Ok(undefined); } },
    ]);
    const req = await requestApproval({ taskId: "tsk_comms", action: "channel:email", reason: "approve", store });
    if (req.isOk) await resolveApproval({ approvalId: req.value.id, decision: "approved", store });

    const outcome = await dispatchCommunication({ agent, channelType: "email", body: "invoice", snapshot: snapshot(), store });
    expect(outcome.kind).toBe("sent");
    expect(sent).toEqual(["invoice"]);
  });

  it("fails when a transport error is returned by the channel", async () => {
    const store = createInMemoryStore();
    const agent = agentWith([
      { type: "slack", enabled: true, sendMessage: async () => Err("network down") },
    ]);
    const outcome = await dispatchCommunication({ agent, channelType: "slack", body: "x", snapshot: snapshot(), store });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toMatch(/send failed: network down/);
  });
});

describe("createChatSdkChannel", () => {
  it("forwards sendMessage to thread.post", async () => {
    const posted: string[] = [];
    const channel = createChatSdkChannel({ type: "slack", thread: { post: async (t) => { posted.push(t); } } });
    const result = await channel.sendMessage("hi", { taskId: "t", executionId: "e", agentName: "a" });
    expect(result.isOk).toBe(true);
    expect(posted).toEqual(["hi"]);
  });

  it("returns Err when thread.post throws", async () => {
    const channel = createChatSdkChannel({ type: "slack", thread: { post: async () => { throw new Error("boom"); } } });
    const result = await channel.sendMessage("hi", { taskId: "t", executionId: "e", agentName: "a" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/chat-sdk post failed: boom/);
  });

  it("carries the requiresApproval flag through", () => {
    const channel = createChatSdkChannel({ type: "email", thread: { post: async () => {} }, requiresApproval: true });
    expect(channel.requiresApproval).toBe(true);
    expect(channel.type).toBe("email");
    expect(channel.enabled).toBe(true);
  });
});
