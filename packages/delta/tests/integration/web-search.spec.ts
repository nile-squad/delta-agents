/**
 * web-search builtin tool — opt-in registration through the tools config.
 *
 * These are deterministic and offline: registration is proven by a schema
 * validation round-trip (which runs before the tool's fn, so no network call is
 * made). The live search path is exercised separately in tests/e2e against a
 * real Exa key. An explicit dummy apiKey is used so construction never depends on
 * the EXA_API_KEY environment variable.
 */

import { describe, it, expect } from "vitest";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";

describe("web-search builtin tool", () => {
  it("registers web-search when opted in with an explicit key", async () => {
    const delta = await createDeltaEngine({
      store: createInMemoryStore(),
      tools: { builtin: { webSearch: { apiKey: "test-key" } } },
    });
    // Schema-invalid input fails validation before the fn runs — so this reaches
    // the tool (proving it is registered) without making a network call. A
    // missing query yields an "invalid" error, not "not found".
    const res = await delta.tools.invoke({ tool: "web-search", input: {} });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("invalid");
  });

  it("does not register web-search when not opted in", async () => {
    const delta = await createDeltaEngine({ store: createInMemoryStore() });
    const res = await delta.tools.invoke({ tool: "web-search", input: { query: "x" } });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("not found");
  });

  it("throws at construction when enabled without an apiKey", async () => {
    await expect(
      createDeltaEngine({
        store: createInMemoryStore(),
        // Bypass the type-level requirement to prove the runtime guard.
        tools: { builtin: { webSearch: {} as { apiKey: string } } },
      }),
    ).rejects.toThrow(/apiKey/);
  });
});
