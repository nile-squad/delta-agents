# Builtin Tools

Builtin tools are ready-made tools the framework provides — you turn one on through engine configuration instead of authoring it by hand. Once declared it behaves exactly like a custom tool: it's global, visible to every agent, and callable both by an agent (via the model) and directly from your code.

All tools an engine exposes — builtin and custom — are declared in one place, the `tools` config, when you create the engine:

```ts
const delta = await createDeltaEngine({
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
  tools: {
    builtin: {
      documentExtract: { ocrEnabled: true, outputFormat: "text", preprocessImages: true },
      // or just: documentExtract: true  (use defaults)
    },
    custom: [/* your own Tool objects */],
  },
});
```

Builtin tools are **opt-in**. Declaring one registers it and loads its dependencies; leaving it undeclared registers nothing and loads none of them. This matters because a builtin may rely on heavy optional dependencies that a consumer who never uses it shouldn't have to install. If you declare a builtin whose dependencies aren't installed, engine construction fails immediately with a message telling you exactly what to install — not a surprise failure later.

## `document-extract`

Reads a **file or image attachment** off the task (by id) and returns its text. It uses [`@llamaindex/liteparse`](https://www.npmjs.com/package/@llamaindex/liteparse) for PDF/Office/image parsing and OCR, and [`sharp`](https://www.npmjs.com/package/sharp) to preprocess images before OCR. Both are **optional peer dependencies** — install them only if you use this tool:

```bash
pnpm add @llamaindex/liteparse sharp
```

> Some formats need system tools too: Office documents (`.docx`, `.xlsx`, …) need LibreOffice on `PATH`; some image formats need ImageMagick. When one is missing, the tool returns an error naming the dependency.

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `ocrEnabled` | `true` | Run OCR for scanned/image content. |
| `ocrLanguage` | `"eng"` | Tesseract language code. |
| `outputFormat` | `"text"` | `"text"` or `"markdown"` (markdown reconstructs headings, tables, lists). |
| `preprocessImages` | `true` | Resize/grayscale/normalize/sharpen an image attachment before OCR. |
| `autoSkipOcr` | `true` | Cheap pre-check: skip OCR entirely for a document whose text layer is already clean. |
| `limits` | — | Per-agent call limits (`maxCallsPerPhase`, `maxCallsPerTask`, `cooldownMs`) for the agent's tool path. |

Its input is `{ attachmentId: string }` — it reads bytes from an attachment already on the task, and never takes a filesystem path or arbitrary URL. That keeps an agent from ever directing it to read a resource outside the task's own attachments.

## Invoking a Tool Directly

Any registered tool — builtin or custom — can be invoked straight from your code with `delta.tools.invoke({ tool, input, ctx? })`. The call shape is the same for every tool. The same tool serves both an agent (which calls it through the model) and you (which calls it directly):

```ts
const res = await delta.tools.invoke({
  tool: "document-extract",
  input: { attachmentId: "att_1" },
  ctx: { attachments: [{ id: "att_1", kind: "file", mimeType: "application/pdf", data: base64Pdf }] },
});

if (res.isOk) console.log(res.value); // the extracted text
else console.error(res.error);
```

`ctx` is the tool's context. `document-extract` needs `attachments`; supply them directly, or build one first with [`loadAttachmentFromFile` / `loadAttachmentFromUrl`](/guide/basics/attachments#loading-from-a-file-or-a-url).

`invoke` validates your input against the tool's schema and runs it. It is intentionally **not** governed the way an agent's tool call is: there's no task, so it records no tool history, charges no budget, and applies no call limits. That governance belongs to the agent's path (the model calling the tool during a task) — `invoke` is the out-of-band developer path.

## Custom Tools Use the Same Surface

`delta.tools.invoke` works for tools you author too. Define a `Tool` object, declare it in `tools.custom`, and it's dev-invokable (and agent-visible) for free:

```ts
const reverse: Tool = {
  name: "reverse",
  description: "Reverse a string",
  schema: z.object({ text: z.string() }),
  fn: async ({ data }) => Ok((data as { text: string }).text.split("").reverse().join("")),
};

const delta = await createDeltaEngine({
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
  tools: { custom: [reverse] },
});

const res = await delta.tools.invoke({ tool: "reverse", input: { text: "delta" } });
// res.value === "atled"
```

See [Tools and Memory](/guide/internals/tools-and-memory) for how tools are defined and how an agent uses them, and [Attachments](/guide/basics/attachments) for the attachment model `document-extract` builds on.
