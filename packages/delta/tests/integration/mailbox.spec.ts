/**
 * Mailbox: durable inbox/outbox with dual-sided read receipts, unsend (recall
 * while unread), and configurable size-cap eviction (oldest read first).
 *
 * Agent-to-agent mentions ride the existing turn-only delivery: a teammate reads
 * a mention when its next turn folds it in, which stamps the receipt visible in
 * the sender's outbox. Unsend is only valid before that read.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import type { ReasonerPort } from "../../src/ports/reasoner-port";
import type { Message } from "../../src/shared/types";

const anAction = (delta: Awaited<ReturnType<typeof createDeltaEngine>>, name: string) =>
  delta.action({ name, description: "work", schema: z.object({}), fn: async () => Ok("ok") });

const deployPair = (delta: Awaited<ReturnType<typeof createDeltaEngine>>) => {
  const base = { description: "d", rolePrompt: ".", actions: [anAction(delta, "noop")] };
  delta.deploy(delta.agent({ name: "lead", role: "Lead", team: "alpha", ...base }));
  delta.deploy(delta.agent({ name: "worker", role: "Worker", team: "alpha", ...base }));
};

describe("mailbox delivery + read receipts", () => {
  it("delivers a mention on the recipient's turn and surfaces the receipt to the sender's outbox", async () => {
    // Lead mentions worker on its first turn, then finishes. Worker later runs and
    // reads the mention (stamping the receipt).
    let leadTurns = 0;
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole }) => {
        if (agentRole === "Lead") {
          leadTurns += 1;
          if (leadTurns === 1) return Ok({ kind: "mention", mention: { agentName: "worker", message: "please review" } });
          return Ok({ kind: "done" });
        }
        return Ok({ kind: "done" });
      },
    };
    const delta = await createDeltaEngine({ reasoner });
    deployPair(delta);

    await delta.send({ goal: "lead", agentName: "lead" });

    // Before worker runs: the message sits unread in worker's inbox, and lead's
    // outbox shows it sent-but-unread.
    const inbox1 = await delta.inbox({ agent: "worker" });
    expect(inbox1.isOk && inbox1.value.length).toBe(1);
    const outbox1 = await delta.outbox({ agent: "lead" });
    expect(outbox1.isOk).toBe(true);
    if (outbox1.isOk) {
      const sent = outbox1.value.find((m) => m.receiver === "worker") as Message;
      expect(sent.readAt).toBeUndefined();
    }

    // Worker runs a turn → reads the mention.
    await delta.send({ goal: "work", agentName: "worker" });

    const outbox2 = await delta.outbox({ agent: "lead" });
    expect(outbox2.isOk).toBe(true);
    if (outbox2.isOk) {
      const sent = outbox2.value.find((m) => m.receiver === "worker" && m.sender === "lead") as Message;
      expect(sent.readAt).toBeInstanceOf(Date); // receipt is visible to the sender
    }
  });
});

describe("unsend", () => {
  it("unsends an unread message and prevents its delivery; rejects unsend after read", async () => {
    // Two separate runs let us unsend between send and the recipient's read.
    let leadTurns = 0;
    const reasoner: ReasonerPort = {
      reason: async ({ agentRole }) => {
        if (agentRole === "Lead") {
          leadTurns += 1;
          if (leadTurns === 1) return Ok({ kind: "mention", mention: { agentName: "worker", message: "ignore me" } });
          return Ok({ kind: "done" });
        }
        return Ok({ kind: "done" });
      },
    };
    const delta = await createDeltaEngine({ reasoner });
    deployPair(delta);
    await delta.send({ goal: "lead", agentName: "lead" });

    const inbox = await delta.inbox({ agent: "worker" });
    expect(inbox.isOk && inbox.value.length).toBe(1);
    const msgId = inbox.isOk ? inbox.value[0]!.id : "";

    // Unsend while unread → succeeds and removes it from the inbox.
    const recalled = await delta.unsend({ messageId: msgId });
    expect(recalled.isOk).toBe(true);
    const inboxAfter = await delta.inbox({ agent: "worker" });
    expect(inboxAfter.isOk && inboxAfter.value.length).toBe(0);

    // Worker runs — nothing to read (recalled), so no receipt.
    await delta.send({ goal: "work", agentName: "worker" });

    // Unsend again is rejected (already recalled).
    const again = await delta.unsend({ messageId: msgId });
    expect(again.isErr).toBe(true);
  });

  it("rejects unsend of an already-read message", async () => {
    const store = createInMemoryStore();
    const now = new Date();
    const read: Message = { id: "r1", taskId: "t", sender: "lead", receiver: "worker", payload: "hi", createdAt: now, readAt: now, deliveredAt: now, consumed: true };
    await store.saveMessage(read);
    const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) }, store });
    const res = await delta.unsend({ messageId: "r1" });
    expect(res.isErr).toBe(true);
  });
});

describe("inbox cap eviction", () => {
  it("evicts oldest READ messages beyond the cap, never unread ones", async () => {
    const store = createInMemoryStore();
    const mk = (id: string, ms: number, read: boolean): Message => ({
      id, taskId: "t", sender: "lead", receiver: "worker", payload: id,
      createdAt: new Date(ms),
      ...(read ? { readAt: new Date(ms), deliveredAt: new Date(ms), consumed: true } : {}),
    });
    // 3 read (old→new) + 1 unread; cap of 2 must drop the 2 oldest READ and keep
    // the newest read + the unread.
    await store.saveMessage(mk("read-old", 1000, true));
    await store.saveMessage(mk("read-mid", 2000, true));
    await store.saveMessage(mk("read-new", 3000, true));
    await store.saveMessage(mk("unread", 4000, false));

    const delta = await createDeltaEngine({ reasoner: { reason: async () => Ok({ kind: "done" }) }, store, mailbox: { inboxCap: 2 } });
    // inbox() enforces the cap opportunistically.
    const inbox = await delta.inbox({ agent: "worker" });
    expect(inbox.isOk).toBe(true);
    if (!inbox.isOk) return;
    const ids = inbox.value.map((m) => m.id).sort();
    expect(ids).toEqual(["read-new", "unread"]);
  });
});
