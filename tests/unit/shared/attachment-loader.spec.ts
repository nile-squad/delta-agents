/**
 * loadAttachmentFromFile / loadAttachmentFromUrl tests. These are the two
 * convenience loaders exported for callers who don't want to hand-roll
 * base64-encoding boilerplate — in particular required for audio, since
 * OpenAI's audio content part takes no URL. Covers the real failure modes:
 * missing mimeType (no extension/header match), a non-ok fetch response, and
 * a fetch that throws outright.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAttachmentFromFile, loadAttachmentFromUrl } from "../../../src/shared/attachment-loader";

describe("loadAttachmentFromFile", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("reads a file and base64-encodes it, inferring mimeType from extension", async () => {
    dir = await mkdtemp(join(tmpdir(), "delta-attach-"));
    const path = join(dir, "note.txt");
    await writeFile(path, "hello world");

    const result = await loadAttachmentFromFile({ path, kind: "file" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.kind).toBe("file");
    expect(result.value.mimeType).toBe("text/plain");
    expect(result.value.name).toBe("note.txt");
    expect(Buffer.from(result.value.data ?? "", "base64").toString("utf-8")).toBe("hello world");
  });

  it("uses an explicit mimeType override instead of the extension", async () => {
    dir = await mkdtemp(join(tmpdir(), "delta-attach-"));
    const path = join(dir, "data.bin");
    await writeFile(path, "abc");

    const result = await loadAttachmentFromFile({ path, kind: "file", mimeType: "application/octet-stream" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.mimeType).toBe("application/octet-stream");
  });

  it("uses an explicit name override instead of the basename", async () => {
    dir = await mkdtemp(join(tmpdir(), "delta-attach-"));
    const path = join(dir, "note.txt");
    await writeFile(path, "hi");

    const result = await loadAttachmentFromFile({ path, kind: "file", name: "custom.txt" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.name).toBe("custom.txt");
  });

  it("returns Err when the extension is unrecognized and no mimeType is given", async () => {
    dir = await mkdtemp(join(tmpdir(), "delta-attach-"));
    const path = join(dir, "mystery.xyz");
    await writeFile(path, "abc");

    const result = await loadAttachmentFromFile({ path, kind: "file" });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("cannot infer mimeType");
  });

  it("returns Err when the file does not exist", async () => {
    const result = await loadAttachmentFromFile({ path: "/nonexistent/path/audio.wav", kind: "audio" });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("loadAttachmentFromFile");
  });
});

describe("loadAttachmentFromUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a URL and base64-encodes the body, inferring mimeType from Content-Type", async () => {
    const bytes = new TextEncoder().encode("image-bytes");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(bytes, { status: 200, headers: { "content-type": "image/png; charset=binary" } }),
      ),
    );

    const result = await loadAttachmentFromUrl({ url: "https://example.com/pic.png", kind: "image" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.mimeType).toBe("image/png");
    expect(result.value.name).toBe("pic.png");
    expect(Buffer.from(result.value.data ?? "", "base64").toString("utf-8")).toBe("image-bytes");
  });

  it("returns Err when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    const result = await loadAttachmentFromUrl({ url: "https://example.com/missing.png", kind: "image" });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("404");
  });

  it("returns Err when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await loadAttachmentFromUrl({ url: "https://example.com/x.wav", kind: "audio" });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("network down");
  });

  it("returns Err when mimeType cannot be inferred (no Content-Type, none given)", async () => {
    // A string body makes the Response constructor auto-set a text/plain
    // Content-Type header; a raw byte body leaves headers exactly as given.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));

    const result = await loadAttachmentFromUrl({ url: "https://example.com/x", kind: "file" });
    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toContain("cannot infer mimeType");
  });

  it("uses an explicit mimeType override instead of the Content-Type header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bytes", { status: 200, headers: { "content-type": "text/plain" } })),
    );

    const result = await loadAttachmentFromUrl({ url: "https://example.com/x.wav", kind: "audio", mimeType: "audio/wav" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.mimeType).toBe("audio/wav");
  });
});
