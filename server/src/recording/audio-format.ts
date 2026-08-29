import type { AudioFormat } from "@quorum/shared";

/**
 * Server-side audio format validation: a session may only announce a
 * format we actually support, and chunk payloads must look like that container —
 * the endpoint is not a generic blob upload.
 */

export interface SupportedFormat {
  container: string;
  codecs: string[];
  /** Magic bytes expected at the start of the very first chunk of a recording. */
  magic: { offset: number; bytes: number[] };
}

/**
 * Containers produced by `MediaRecorder` (ADR-002): WebM/Ogg with Opus on
 * Chromium/Firefox, MP4 with AAC on Safari.
 */
export const SUPPORTED_FORMATS: readonly SupportedFormat[] = [
  // EBML header — WebM/Matroska
  { container: "webm", codecs: ["opus"], magic: { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] } },
  // "OggS" capture pattern
  { container: "ogg", codecs: ["opus"], magic: { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] } },
  // ISO base media file format: "ftyp" at byte 4
  {
    container: "mp4",
    codecs: ["aac", "mp4a"],
    magic: { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  },
];

export const MIN_SAMPLE_RATE = 8_000;
export const MAX_SAMPLE_RATE = 192_000;
export const MAX_CHANNELS = 2;

/** Upper bound for a single chunk payload: 1–2 s of audio, generously sized. */
export const MAX_CHUNK_PAYLOAD_BYTES = 1_048_576; // 1 MiB

export type FormatCheck = { ok: true; format: SupportedFormat } | { ok: false; reason: string };

export function checkAudioFormat(audioFormat: AudioFormat): FormatCheck {
  const container = audioFormat.container.toLowerCase();
  const codec = audioFormat.codec.toLowerCase();
  const format = SUPPORTED_FORMATS.find((candidate) => candidate.container === container);
  if (!format) {
    return { ok: false, reason: `unsupported container "${audioFormat.container}"` };
  }
  if (!format.codecs.some((supported) => codec.startsWith(supported))) {
    return {
      ok: false,
      reason: `codec "${audioFormat.codec}" is not valid for container "${container}"`,
    };
  }
  if (audioFormat.sampleRate < MIN_SAMPLE_RATE || audioFormat.sampleRate > MAX_SAMPLE_RATE) {
    return { ok: false, reason: `sample rate ${audioFormat.sampleRate} out of range` };
  }
  if (audioFormat.channels > MAX_CHANNELS) {
    return { ok: false, reason: `channel count ${audioFormat.channels} out of range` };
  }
  return { ok: true, format };
}

/**
 * Container sanity check for the first chunk of a recording. Later chunks are
 * continuation bytes of the same stream and carry no header, so only their size
 * is validated.
 */
export function matchesContainer(format: SupportedFormat, payload: Uint8Array): boolean {
  const { offset, bytes } = format.magic;
  if (payload.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => payload[offset + index] === byte);
}
