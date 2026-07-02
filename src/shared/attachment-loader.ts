/**
 * Convenience loaders that turn a local file or a remote URL into an
 * AttachmentInput ready to pass to send(). Not part of the core send() path —
 * the engine itself never touches the filesystem or makes network calls; a
 * caller resolves bytes explicitly, the same way they'd already await a DB
 * read before building a request. Node-only (this is a backend framework):
 * loadAttachmentFromFile uses node:fs/promises, loadAttachmentFromUrl uses
 * the global fetch available in Node 18+.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Err, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import type { AttachmentInput } from "./types";

// Common extensions this codebase can confidently map without guessing.
// An unrecognized extension requires an explicit mimeType override rather
// than a silent guess.
const EXTENSION_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/**
 * Read a local file and produce an AttachmentInput with base64-encoded `data`.
 * mimeType is inferred from the file extension when not given explicitly; an
 * unrecognized extension without an explicit mimeType is an Err rather than a
 * guess (a wrong guess silently corrupts what the model or a tool receives).
 */
export const loadAttachmentFromFile = async ({
  path,
  kind,
  mimeType,
  name,
}: {
  path: string;
  kind: AttachmentInput["kind"];
  mimeType?: string;
  name?: string;
}): Promise<Result<AttachmentInput, string>> => {
  const resolvedMimeType = mimeType ?? EXTENSION_MIME_TYPES[extname(path).toLowerCase()];
  if (resolvedMimeType === undefined) {
    return Err(`loadAttachmentFromFile: cannot infer mimeType for "${path}" — pass mimeType explicitly`);
  }
  const result = await safeTry(async () => {
    const buffer = await readFile(path);
    return {
      kind,
      mimeType: resolvedMimeType,
      data: buffer.toString("base64"),
      name: name ?? basename(path),
    } satisfies AttachmentInput;
  });
  return result.isErr ? Err(`loadAttachmentFromFile: ${result.error}`) : result;
};

/**
 * Fetch a remote URL and produce an AttachmentInput with base64-encoded
 * `data` (not `url` — the point of this loader is to pre-fetch and embed).
 * Needed in particular for audio attachments, since OpenAI's audio content
 * part does not accept a URL the way its image content part does. mimeType
 * is inferred from the response's Content-Type header when not given
 * explicitly.
 */
export const loadAttachmentFromUrl = async ({
  url,
  kind,
  mimeType,
  name,
}: {
  url: string;
  kind: AttachmentInput["kind"];
  mimeType?: string;
  name?: string;
}): Promise<Result<AttachmentInput, string>> => {
  const result = await safeTry(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`fetch failed with status ${response.status} for "${url}"`);
    }
    const resolvedMimeType = mimeType ?? response.headers.get("content-type")?.split(";")[0] ?? undefined;
    if (resolvedMimeType === undefined) {
      throw new Error(`cannot infer mimeType for "${url}" (no Content-Type header) — pass mimeType explicitly`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const inferredName = name ?? new URL(url).pathname.split("/").filter(Boolean).pop();
    return {
      kind,
      mimeType: resolvedMimeType,
      data: buffer.toString("base64"),
      ...(inferredName !== undefined ? { name: inferredName } : {}),
    } satisfies AttachmentInput;
  });
  return result.isErr ? Err(`loadAttachmentFromUrl: ${result.error}`) : result;
};
