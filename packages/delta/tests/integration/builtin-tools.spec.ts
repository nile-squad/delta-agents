/**
 * Builtin tools — opt-in registration through createDeltaEngine's tools config.
 *
 * Declaring `tools.builtin.documentExtract` registers "document-extract" as a
 * global tool; omitting it leaves the tool unregistered (and its peer deps
 * untouched). Both are proven via a delta.tools.invoke round-trip.
 */

import { describe, it, expect } from "vitest";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";

describe("builtin tools", () => {
  it("registers document-extract when opted in", async () => {
    const delta = await createDeltaEngine({
      store: createInMemoryStore(),
      tools: { builtin: { documentExtract: true } },
    });
    // Invoke with a non-existent attachment: reaching the tool's own "no
    // attachment" Err (rather than the facade's "not found") proves it is
    // registered and running.
    const res = await delta.tools.invoke({
      tool: "document-extract",
      input: { attachmentId: "nope" },
      ctx: { attachments: [] },
    });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("no attachment");
  });

  it("accepts an options object for document-extract", async () => {
    const delta = await createDeltaEngine({
      store: createInMemoryStore(),
      tools: { builtin: { documentExtract: { ocrEnabled: false, outputFormat: "markdown" } } },
    });
    const res = await delta.tools.invoke({
      tool: "document-extract",
      input: { attachmentId: "nope" },
      ctx: { attachments: [] },
    });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("no attachment");
  });

  it("does not register document-extract when not opted in", async () => {
    const delta = await createDeltaEngine({ store: createInMemoryStore() });
    const res = await delta.tools.invoke({ tool: "document-extract", input: { attachmentId: "x" } });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("not found");
  });
});
