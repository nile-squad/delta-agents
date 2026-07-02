/**
 * Maps an audio attachment's mimeType to the format OpenAI's audio content
 * part requires. OpenAI's `input_audio` content part only supports "wav" and
 * "mp3" — there is no generic "send whatever mimeType" path the way there is
 * for images, so an unmappable mimeType is a real, actionable failure rather
 * than something to silently coerce.
 */
export const audioFormatFromMimeType = (mimeType: string): "wav" | "mp3" | undefined => {
  const normalized = mimeType.toLowerCase();
  if (normalized === "audio/wav" || normalized === "audio/x-wav" || normalized === "audio/wave") return "wav";
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
  return undefined;
};
