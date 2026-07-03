/**
 * Builtin tool: document/image → text extraction.
 *
 * Reads a file or image attachment off the task (by id) and returns its text,
 * using @llamaindex/liteparse (PDF/Office/image parsing + OCR) and, for image
 * attachments, sharp preprocessing to make OCR more reliable.
 *
 * WHY a factory that lazily imports its deps: @llamaindex/liteparse and sharp
 * ship heavy native bindings (liteparse alone unpacks to ~22MB) and are optional
 * peer dependencies. A consumer who never opts into this tool must never load
 * them. The factory is only ever reached through a dynamic `import()` in
 * create-delta-engine, gated on `builtinTools.documentExtract` being set — so
 * `import "delta-agents"` alone never touches these modules. The factory itself
 * then imports them dynamically, throwing an actionable install hint if they are
 * absent (a construction-time setup error, surfaced immediately — the same shape
 * as createDeltaEngine throwing for a missing default model).
 *
 * WHY the tool never touches the filesystem or network by "path": its only input
 * is an attachment id resolved against the task's own attachments. An agent can
 * therefore never make it read an arbitrary path or fetch an arbitrary URL (no
 * SSRF / arbitrary-read surface). A developer who wants to extract a local file
 * or remote URL resolves the bytes first with loadAttachmentFromFile /
 * loadAttachmentFromUrl and passes the resulting attachment through the context.
 */

import { z } from "zod";
import { Ok, Err, option, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import type { Tool, ToolContext } from "../authoring/types";

/** Options for the document-extract builtin tool. All optional; see defaults on each field. */
export type DocumentExtractOptions = {
  /** Enable OCR for scanned/image content. Default true. */
  ocrEnabled?: boolean;
  /** Tesseract language code. Default "eng". */
  ocrLanguage?: string;
  /** Rendered output format. Default "text". */
  outputFormat?: "text" | "markdown";
  /** Run sharp preprocessing (resize/grayscale/normalize/sharpen) before OCR on image attachments. Default true. */
  preprocessImages?: boolean;
  /**
   * When ocrEnabled, run liteparse's cheap isComplex() pre-check first and skip
   * OCR for documents whose text layer is already clean. Faster on the common
   * case (a normal text-layer PDF), invisible to the caller. Default true.
   */
  autoSkipOcr?: boolean;
  /**
   * Per-agent call limits passed straight through to Tool.limits — governs the
   * agent's system:use_tool path (cooldown / max calls), not delta.tools.invoke.
   */
  limits?: { maxCallsPerPhase?: number; maxCallsPerTask?: number; cooldownMs?: number };
};

const MISSING_DEPS_HINT =
  "builtinTools.documentExtract requires @llamaindex/liteparse and sharp — install them: pnpm add @llamaindex/liteparse sharp";

// Minimal structural shapes for the parts of the liteparse/sharp APIs this tool
// uses. The real packages are optional peer deps loaded at runtime, so we type
// the dynamic-import surface locally rather than depend on their types at build.
type LiteParseCtor = new (config: {
  ocrEnabled: boolean;
  ocrLanguage: string;
  outputFormat: "text" | "markdown";
  quiet: boolean;
}) => {
  parse: (input: Buffer) => Promise<{ text?: string }>;
  isComplex: (input: Buffer) => Promise<Array<{ needsOcr: boolean }>>;
};
type SharpFn = (input: Buffer) => {
  resize: (opts: { width: number; withoutEnlargement: boolean }) => {
    grayscale: () => {
      normalize: () => {
        sharpen: (opts: { sigma: number }) => { toBuffer: () => Promise<Buffer> };
      };
    };
  };
};

/**
 * Build the document-extract tool. Async: it dynamically imports its optional
 * peer deps up front (so a missing dep fails loudly at engine construction, not
 * mid-task) and closes over the loaded bindings so the tool fn reuses them
 * without re-importing per call.
 */
export const createDocumentExtractTool = async (
  options: DocumentExtractOptions = {},
): Promise<Tool> => {
  const ocrEnabled = options.ocrEnabled ?? true;
  const ocrLanguage = options.ocrLanguage ?? "eng";
  const outputFormat = options.outputFormat ?? "text";
  const preprocessImages = options.preprocessImages ?? true;
  const autoSkipOcr = options.autoSkipOcr ?? true;

  const liteparseMod = await safeTry(async () => import("@llamaindex/liteparse"));
  if (liteparseMod.isErr) throw new Error(MISSING_DEPS_HINT);
  const LiteParse = (liteparseMod.value as { LiteParse: LiteParseCtor }).LiteParse;

  let sharpFn: SharpFn | undefined;
  if (preprocessImages) {
    const sharpMod = await safeTry(async () => import("sharp"));
    if (sharpMod.isErr) throw new Error(MISSING_DEPS_HINT);
    sharpFn = (sharpMod.value as { default: SharpFn }).default;
  }

  return {
    name: "document-extract",
    description:
      "Extract text from a file or image attachment by its id. Supports PDF, " +
      "Office documents, and images (via OCR). Returns the extracted text.",
    schema: z.object({ attachmentId: z.string() }),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    fn: async ({ data, ctx }: { data: unknown; ctx: ToolContext }): Promise<Result<unknown, string>> => {
      const { attachmentId } = data as { attachmentId: string };

      const attOpt = option(ctx.attachments?.find((a) => a.id === attachmentId));
      if (attOpt.isNone) {
        return Err(`document-extract: no attachment with id "${attachmentId}" on this task`);
      }
      const att = attOpt.value;

      if (att.kind === "audio") {
        return Err("document-extract: audio attachments are not documents — cannot extract text");
      }

      // Resolve the attachment's raw bytes to a Buffer.
      let buffer: Buffer;
      if (att.data !== undefined) {
        buffer = Buffer.from(att.data, "base64");
      } else if (att.url !== undefined) {
        const fetched = await safeTry(async () => {
          const res = await fetch(att.url as string);
          if (!res.ok) throw new Error(`fetch failed with status ${res.status} for "${att.url}"`);
          return Buffer.from(await res.arrayBuffer());
        });
        if (fetched.isErr) return Err(`document-extract: could not fetch attachment url — ${fetched.error}`);
        buffer = fetched.value;
      } else {
        return Err(`document-extract: attachment "${attachmentId}" has neither data nor url`);
      }

      // Image preprocessing: resize/grayscale/normalize/sharpen before OCR so
      // photographed or low-contrast documents read more reliably.
      if (att.kind === "image" && sharpFn !== undefined) {
        const sharpen = sharpFn;
        const pre = await safeTry(async () =>
          sharpen(buffer).resize({ width: 2400, withoutEnlargement: false }).grayscale().normalize().sharpen({ sigma: 1.5 }).toBuffer(),
        );
        if (pre.isErr) return Err(`document-extract: image preprocessing failed — ${pre.error}`);
        buffer = pre.value;
      }

      // OCR decision: default to the configured ocrEnabled, but when auto-skip is
      // on, use the cheap isComplex() pre-check to turn OCR off for a document
      // whose text layer is already clean. The pre-check is best-effort — if it
      // errors, fall back to the configured ocrEnabled rather than failing.
      let useOcr = ocrEnabled;
      if (ocrEnabled && autoSkipOcr) {
        const complexity = await safeTry(async () => new LiteParse({ ocrEnabled, ocrLanguage, outputFormat, quiet: true }).isComplex(buffer));
        if (complexity.isOk && !complexity.value.some((p) => p.needsOcr)) {
          useOcr = false;
        }
      }

      const parser = new LiteParse({ ocrEnabled: useOcr, ocrLanguage, outputFormat, quiet: true });
      const parseRes = await safeTry(async () => parser.parse(buffer));
      if (parseRes.isErr) {
        const lower = parseRes.error.toLowerCase();
        if (lower.includes("libreoffice") || lower.includes("soffice")) {
          return Err(
            `document-extract: parsing Office documents requires LibreOffice to be installed and on PATH — ${parseRes.error}`,
          );
        }
        if (lower.includes("imagemagick") || lower.includes("magick") || lower.includes("convert")) {
          return Err(
            `document-extract: parsing this image format requires ImageMagick to be installed and on PATH — ${parseRes.error}`,
          );
        }
        return Err(`document-extract: parse failed — ${parseRes.error}`);
      }

      const text = parseRes.value.text?.trim() ?? "";
      if (text.length === 0) {
        return Err("document-extract: no text extracted from the attachment");
      }
      return Ok(text);
    },
  };
};
