# Attachments

A goal can carry images, audio, or files alongside its text. `send` accepts an `attachments` array; the engine assigns each one an id and makes it available to the agent for the life of the task.

```ts
const result = await delta.send({
  goal: "Summarize this invoice",
  agentName: "support-agent",
  attachments: [
    { kind: "image", mimeType: "image/png", data: base64Png, name: "invoice.png" },
  ],
});
```

## Fields

| Field | Type | Meaning |
|-------|------|---------|
| `kind` | `"image" \| "audio" \| "file"` | Required. States intent explicitly — never inferred from `mimeType`. |
| `mimeType` | `string` | e.g. `"image/png"`, `"audio/wav"`, `"application/pdf"`. |
| `data` | `string` | Optional. Base64-encoded content. |
| `url` | `string` | Optional. A remote URL, as an alternative to inline `data`. Image only — see below for why audio can't use this. |
| `name` | `string` | Optional. Filename, for audit/display. |

The engine assigns the `id` — a caller never supplies one, the same way a `TaskID` is always engine-issued rather than caller-guessable. Every attachment must carry at least one of `data`/`url`; `send` rejects one with neither before any task is created.

## Images and Audio Are Perceived, Files Are Referenced

`kind: "image"` and `kind: "audio"` attachments are embedded as real multimodal content in the model's request, when the agent's model supports that kind (see below). The model literally sees the image or hears the audio.

`kind: "file"` attachments are never sent to the model as raw bytes — not every provider or model can ingest an arbitrary file as chat content. Instead, the model sees a short reference: an id, a MIME type, and a name, plus a note that reading the file requires a tool built for that purpose. Extraction tools that read a file attachment by id are on the roadmap; this release ships the plumbing (the reference reaches the model and the raw bytes are available to a tool via `ToolContext.attachments`), not the extraction tool itself.

### Audio Needs `data`, Not Just `url`

Unlike images, an audio attachment can't be a bare remote URL — the provider's audio content part only accepts inline base64 `data` plus an explicit format. `mimeType` must map to a supported format (currently `wav` or `mp3`); an unmappable `mimeType`, or an audio attachment supplying only `url`, fails at `send()` time with a message pointing you at `loadAttachmentFromUrl` (below) to resolve it first.

```ts
attachments: [{ kind: "audio", mimeType: "audio/wav", url: "https://..." }]
// Err: "... has only a 'url' — ... requires base64 'data' ... Use loadAttachmentFromUrl to fetch and embed it first."
```

## Capability Requires an Explicit Model Flag

A model must declare `vision: true` and/or `audio: true` before it can receive the matching attachment kind:

```ts
const delta = await createDeltaEngine({
  models: [{ name: "multimodal", model: "gpt-4o-audio-preview", vision: true, audio: true, default: true }],
});
```

Sending an image or audio attachment to an agent whose resolved model doesn't declare the matching flag fails immediately — `send` returns `Err`, and no task is created:

```ts
const result = await delta.send({
  goal: "What's in this photo?",
  agentName: "text-only-agent",
  attachments: [{ kind: "image", mimeType: "image/jpeg", data: base64Jpg }],
});
// result.isErr — "model ... is not vision-capable ..."
```

This is deliberate: a dropped image or audio clip would be a silent capability gap, where the caller believes the model received something it never got. Rejecting up front keeps the failure visible and immediate.

## Attachments Persist For the Task

An attachment stays part of the task's state for that task's entire run, the same way the goal and tool history do. Every reasoner turn is a fresh reconstruction of the model's context from the current task state, so an attachment supplied at the start remains visible on later turns rather than being shown once and forgotten.

## Loading From a File or a URL

The engine itself never touches the filesystem or makes a network call — you resolve an attachment's bytes yourself before calling `send`. Two exported helpers cover the common cases so you don't have to write base64-encoding boilerplate:

```ts
import { loadAttachmentFromFile, loadAttachmentFromUrl } from "delta-agents";

const fileResult = await loadAttachmentFromFile({
  path: "./invoice.png",
  kind: "image",
  // mimeType inferred from the extension when omitted; pass it explicitly for
  // anything outside the built-in map (png, jpg, gif, webp, pdf, txt, csv,
  // json, md, wav, mp3).
});

const urlResult = await loadAttachmentFromUrl({
  url: "https://example.com/clip.wav",
  kind: "audio",
  // mimeType inferred from the response's Content-Type header when omitted.
});

if (fileResult.isOk) {
  await delta.send({
    goal: "Summarize this invoice",
    agentName: "support-agent",
    attachments: [fileResult.value],
  });
}
```

Both return `Result<AttachmentInput, string>` — `Err` on a missing file, an unreachable URL, a non-2xx response, or an unresolvable `mimeType`. `loadAttachmentFromUrl` always produces `data` (it fetches and embeds), never a bare `url` passthrough — this is what makes it the right tool for resolving a remote audio clip, since a raw `url` attachment isn't valid for `kind: "audio"` in the first place.

## Reading a File From a Tool

A tool's execution context carries the task's attachments so a future extraction tool can look one up by id:

```ts
const extractText = delta.tool({
  name: "extract-text",
  description: "Extract text from an attached file",
  schema: z.object({ attachmentId: z.string() }),
  fn: async ({ data, ctx }) => {
    const { attachmentId } = data as { attachmentId: string };
    const attachment = ctx.attachments?.find((a) => a.id === attachmentId);
    if (attachment === undefined) return Err(`no attachment "${attachmentId}"`);
    // ... decode attachment.data / fetch attachment.url and parse it
    return Ok("extracted text");
  },
});
```

See [Tools and Memory](/guide/internals/tools-and-memory) for how tools are registered and called.
