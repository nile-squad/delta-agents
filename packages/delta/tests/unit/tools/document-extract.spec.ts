/**
 * document-extract builtin tool.
 *
 * The factory loads its optional peer deps (@llamaindex/liteparse, sharp), which
 * are present as devDependencies in this repo, so the tool constructs here. These
 * tests cover the tool's own logic — attachment lookup, kind rejection, and a
 * real extraction against a generated minimal PDF — not liteparse internals.
 */

import { describe, it, expect } from "vitest";
import { createDocumentExtractTool } from "../../../src/tools/document-extract";
import type { ToolContext } from "../../../src/authoring/types";
import type { Attachment } from "../../../src/shared/types";

/**
 * Build a minimal single-page PDF with a text layer, computing xref byte offsets
 * from the actual assembled bytes so the result is a structurally valid PDF that
 * pdfium (liteparse's engine) can extract text from — no committed binary fixture
 * or PDF library needed.
 */
const buildMinimalPdf = (text: string): Buffer => {
  const streamContent = `BT /F1 18 Tf 40 120 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const header = "%PDF-1.4\n";
  const offsets: number[] = [];
  let body = "";
  let pos = header.length;
  for (let i = 0; i < objects.length; i++) {
    const objStr = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    offsets.push(pos);
    body += objStr;
    pos += Buffer.byteLength(objStr, "latin1");
  }
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, "latin1");
};

const ctxWith = (attachments: Attachment[]): ToolContext => ({
  agentName: "test",
  taskId: "t1",
  toolHistory: [],
  attachments,
});

describe("document-extract tool", () => {
  it("builds a tool with the expected name and schema", async () => {
    const tool = await createDocumentExtractTool();
    expect(tool.name).toBe("document-extract");
    expect(tool.schema.safeParse({ attachmentId: "x" }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it("returns Err when the attachment id is not on the task", async () => {
    const tool = await createDocumentExtractTool();
    const res = await tool.fn({ data: { attachmentId: "missing" }, ctx: ctxWith([]) });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("no attachment");
  });

  it("returns Err for an audio attachment", async () => {
    const tool = await createDocumentExtractTool();
    const att: Attachment = { id: "a1", kind: "audio", mimeType: "audio/wav", data: "x" };
    const res = await tool.fn({ data: { attachmentId: "a1" }, ctx: ctxWith([att]) });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("audio");
  });

  it("extracts text from a PDF file attachment", async () => {
    const tool = await createDocumentExtractTool({ ocrEnabled: false });
    const pdf = buildMinimalPdf("Hello Delta");
    const att: Attachment = {
      id: "doc1",
      kind: "file",
      mimeType: "application/pdf",
      data: pdf.toString("base64"),
    };
    const res = await tool.fn({ data: { attachmentId: "doc1" }, ctx: ctxWith([att]) });
    expect(res.isOk).toBe(true);
    if (res.isOk) expect(String(res.value)).toContain("Hello Delta");
  });
});
