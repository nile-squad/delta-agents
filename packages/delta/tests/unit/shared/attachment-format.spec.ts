/**
 * audioFormatFromMimeType tests — OpenAI's input_audio content part only
 * accepts "wav" or "mp3"; every other mimeType must map to undefined so
 * callers can fail fast rather than send a broken request.
 */

import { describe, it, expect } from "vitest";
import { audioFormatFromMimeType } from "../../../src/shared/attachment-format";

describe("audioFormatFromMimeType", () => {
  it("maps wav variants", () => {
    expect(audioFormatFromMimeType("audio/wav")).toBe("wav");
    expect(audioFormatFromMimeType("audio/x-wav")).toBe("wav");
    expect(audioFormatFromMimeType("audio/wave")).toBe("wav");
    expect(audioFormatFromMimeType("AUDIO/WAV")).toBe("wav");
  });

  it("maps mp3 variants", () => {
    expect(audioFormatFromMimeType("audio/mpeg")).toBe("mp3");
    expect(audioFormatFromMimeType("audio/mp3")).toBe("mp3");
    expect(audioFormatFromMimeType("Audio/Mpeg")).toBe("mp3");
  });

  it("returns undefined for unsupported mimeTypes", () => {
    expect(audioFormatFromMimeType("audio/ogg")).toBeUndefined();
    expect(audioFormatFromMimeType("image/png")).toBeUndefined();
    expect(audioFormatFromMimeType("")).toBeUndefined();
  });
});
