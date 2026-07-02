/**
 * send() attachment validation — covers the fail-fast checks added alongside
 * audio attachment support: every attachment needs data or url, audio
 * attachments specifically need base64 data (not a bare url) and a
 * wav/mp3-mappable mimeType, and the vision/audio model-capability gates.
 * All of these must reject before a task is ever created (no silent drop,
 * no broken request built later).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createMockReasoner } from "../../src/ports/mock-reasoner";

const buildAgent = async (models?: Array<{ name: string; model: string; default?: boolean; vision?: boolean; audio?: boolean }>) => {
  const delta = await createDeltaEngine({
    ...(models !== undefined ? { models } : { reasoner: createMockReasoner() }),
  });
  const ping = delta.action({
    name: "ping",
    description: "ping",
    schema: z.object({}),
    fn: async () => Ok("pong"),
  });
  const agent = delta.agent({
    name: "attach-agent",
    description: "agent for attachment tests",
    role: "tester",
    rolePrompt: "run tests",
    actions: [ping],
    ...(models !== undefined ? { model: models[0]?.name } : {}),
  });
  delta.deploy(agent);
  return delta;
};

describe("send() attachment validation", () => {
  it("rejects an attachment with neither data nor url", async () => {
    const delta = await buildAgent();
    const result = await delta.send({
      goal: "look at this",
      agentName: "attach-agent",
      attachments: [{ kind: "file", mimeType: "text/plain", name: "note.txt" }],
    });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain('has neither "data" nor "url"');
    expect(result.error).toContain("note.txt");
  });

  it("rejects an audio attachment that only has a url (no data)", async () => {
    const delta = await buildAgent();
    const result = await delta.send({
      goal: "listen to this",
      agentName: "attach-agent",
      attachments: [{ kind: "audio", mimeType: "audio/wav", url: "https://example.com/clip.wav" }],
    });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("requires base64 \"data\"");
    expect(result.error).toContain("loadAttachmentFromUrl");
  });

  it("rejects an audio attachment with an unsupported mimeType", async () => {
    const delta = await buildAgent();
    const result = await delta.send({
      goal: "listen to this",
      agentName: "attach-agent",
      attachments: [{ kind: "audio", mimeType: "audio/ogg", data: "AAAA" }],
    });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("unsupported mimeType");
  });

  it("accepts a valid wav audio attachment with data", async () => {
    const delta = await buildAgent();
    const result = await delta.send({
      goal: "listen to this",
      agentName: "attach-agent",
      attachments: [{ kind: "audio", mimeType: "audio/wav", data: "AAAA" }],
    });
    expect(result.isOk).toBe(true);
  });

  it("rejects audio attachments when the resolved model does not declare audio: true", async () => {
    const delta = await buildAgent([{ name: "text-only", model: "gpt-4o-mini", default: true }]);
    const result = await delta.send({
      goal: "listen to this",
      agentName: "attach-agent",
      attachments: [{ kind: "audio", mimeType: "audio/wav", data: "AAAA" }],
    });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("is not audio-capable");
  });

  it("still rejects image attachments when the resolved model does not declare vision: true", async () => {
    const delta = await buildAgent([{ name: "text-only", model: "gpt-4o-mini", default: true }]);
    const result = await delta.send({
      goal: "look at this",
      agentName: "attach-agent",
      attachments: [{ kind: "image", mimeType: "image/png", data: "AAAA" }],
    });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("is not vision-capable");
  });
});
