import { z } from "zod";
import { AudioFormatSchema } from "@quorum/shared";
import { JobError } from "../errors.js";
import { chunkKey, type KeyScope } from "./keys.js";

/**
 * The finalization manifest written by the recording endpoint on `session.end`.
 * Validated rather than trusted: it is the contract between two processes, and
 * a malformed manifest must fail the job with a clear code instead of producing
 * a half-assembled audio file.
 */
export const RecordingManifestSchema = z.object({
  sessionId: z.string(),
  meetingId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  audioFormat: AudioFormatSchema,
  chunkCount: z.number().int().nonnegative(),
  persistedSeq: z.number().int(),
  chunkKeys: z.array(z.string()),
  /**
   * The seekable file the chunks were repackaged into, once that has happened (ADR-010).
   *
   * `null` — and an absent field, which is what every manifest written before this existed
   * looks like — means the recording is still its chunk objects. Defaulted rather than
   * required for exactly that reason: an older recording is not a malformed one.
   */
  audioKey: z.string().nullable().default(null),
  /**
   * Playing time the repackaged file declares, in seconds; `null` until it has been produced.
   *
   * Not to be confused with `recordedSeconds` below, which is what the *client* asserted before
   * anything decoded the audio, nor with the transcript's duration, which is what the backend
   * measured. This one is a property of the container: it is what a player draws a scrub bar
   * from, and it is the only one of the three that nothing bills against.
   */
  artifactDurationSeconds: z.number().nonnegative().nullable().default(null),
  marks: z.array(z.object({ type: z.enum(["pause", "resume"]), at: z.string() })).default([]),
  /**
   * Seconds of audio the client asserted, from the chunk offsets the recording endpoint saw.
   *
   * Nullable and defaulted: a manifest written before this field existed asserts nothing, and a
   * recording still waiting to be transcribed must not fail its job over that. Absent reads as
   * "no assertion to reconcile against", never as zero seconds recorded — see
   * `transcript/duration.ts`.
   */
  recordedSeconds: z.number().nullable().default(null),
  finalizedAt: z.string(),
});

export type RecordingManifest = z.infer<typeof RecordingManifestSchema>;

/** Session metadata written before the first chunk; carries the recording start. */
export const SessionRecordSchema = z.object({
  sessionId: z.string(),
  meetingId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  meetingTitle: z.string().nullable().default(null),
  /**
   * Template chosen for this meeting before recording started, or `null` for no
   * choice. Defaulted rather than required: sessions written before this field
   * existed are still waiting to be transcribed, and their absence of a choice
   * is a meaning, not a parse failure.
   */
  summaryTemplateId: z.string().nullable().default(null),
  audioFormat: AudioFormatSchema,
  createdAt: z.string(),
  marks: z.array(z.object({ type: z.enum(["pause", "resume"]), at: z.string() })).default([]),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * Resolves the ordered list of chunk objects that make up the recording.
 *
 * `chunkKeys` from the manifest is authoritative when present, but it is
 * reconstructed from `chunkCount` otherwise — the key is a pure function of the
 * sequence number, so both paths must agree. The result is verified to be
 * contiguous and correctly ordered: a gap means a chunk never reached object
 * storage, and concatenating around it would silently produce audio with a hole
 * in it.
 */
export function resolveChunkKeys(manifest: RecordingManifest, scope: KeyScope): string[] {
  const expectedCount = manifest.persistedSeq + 1;
  if (manifest.chunkCount !== expectedCount) {
    throw new JobError(
      "AUDIO_EMPTY",
      `manifest is inconsistent: chunkCount ${manifest.chunkCount} does not match persistedSeq ${manifest.persistedSeq}`,
      { retryable: false },
    );
  }
  if (expectedCount <= 0) {
    throw new JobError("AUDIO_EMPTY", "session was finalized without a single chunk", {
      retryable: false,
    });
  }

  const expected = Array.from({ length: expectedCount }, (_value, seq) => chunkKey(scope, seq));
  if (manifest.chunkKeys.length === 0) return expected;

  if (manifest.chunkKeys.length !== expectedCount) {
    throw new JobError(
      "AUDIO_EMPTY",
      `manifest lists ${manifest.chunkKeys.length} chunk keys but announces ${expectedCount}`,
      { retryable: false },
    );
  }
  const mismatch = manifest.chunkKeys.findIndex((key, index) => key !== expected[index]);
  if (mismatch !== -1) {
    throw new JobError(
      "AUDIO_EMPTY",
      `chunk key at position ${mismatch} does not follow the expected layout`,
      { retryable: false },
    );
  }
  return manifest.chunkKeys;
}

/**
 * Concatenates chunk payloads into the byte stream the recorder produced.
 *
 * The recording endpoint stores one object per chunk (so re-sends are idempotent
 * overwrites); a MediaRecorder stream is a single container whose chunks are
 * continuation bytes, so plain ordered concatenation reproduces the original
 * file. No transcoding happens here — the transcription backend does that.
 */
export function concatenateChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total === 0) {
    throw new JobError("AUDIO_EMPTY", "assembled audio is empty", { retryable: false });
  }
  const assembled = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    assembled.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return assembled;
}

/** Filename and MIME type the transcription backend sees for a given container. */
export function audioFileDescriptor(container: string): { filename: string; contentType: string } {
  switch (container.toLowerCase()) {
    case "webm":
      return { filename: "recording.webm", contentType: "audio/webm" };
    case "ogg":
      return { filename: "recording.ogg", contentType: "audio/ogg" };
    case "mp4":
      return { filename: "recording.mp4", contentType: "audio/mp4" };
    default:
      throw new JobError("AUDIO_DECODE_FAILED", `unsupported audio container "${container}"`, {
        retryable: false,
      });
  }
}
