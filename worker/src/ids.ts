import { createHash } from "node:crypto";

/**
 * Deterministic identifiers (RFC 4122 version 5, SHA-1 based).
 *
 * Idempotency is the reason this exists: a job that is retried — or replayed
 * after a worker crash — must produce the exact same transcript and segment ids,
 * so a re-run is an overwrite of identical data rather than a second transcript.
 * It also makes the mapping a pure function, which is what the tests assert on.
 */

/** Namespace for everything Quorum derives; itself a v5 UUID of a fixed name. */
export const QUORUM_UUID_NAMESPACE = "6b5f1f0a-3d1e-5a7c-9c2e-2d9b7f4a1c30";

function parseUuid(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`invalid UUID: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** RFC 4122 §4.3 name-based UUID using SHA-1. */
export function uuidV5(name: string, namespace: string = QUORUM_UUID_NAMESPACE): string {
  const hash = createHash("sha1");
  hash.update(parseUuid(namespace));
  hash.update(Buffer.from(name, "utf8"));
  const digest = new Uint8Array(hash.digest()).slice(0, 16);
  // Version 5 and the RFC 4122 variant.
  digest[6] = ((digest[6] as number) & 0x0f) | 0x50;
  digest[8] = ((digest[8] as number) & 0x3f) | 0x80;
  return formatUuid(digest);
}

/** One transcript per job — the id is derived from the job id. */
export function transcriptIdForJob(jobId: string): string {
  return uuidV5(`transcript:${jobId}`);
}

/** Stable segment ids (ADR-003 §1) derived from the transcript and its index. */
export function segmentId(transcriptId: string, index: number): string {
  return uuidV5(`segment:${transcriptId}:${index}`);
}

/** One summary per summarize job — same rule as the transcript. */
export function summaryIdForJob(jobId: string): string {
  return uuidV5(`summary:${jobId}`);
}

/**
 * The id of the summarize job a finished transcript produces.
 *
 * Derived rather than random so the enqueue is idempotent: a transcribe job
 * that is replayed after a crash computes the same summarize job id, and the
 * pg-boss singleton key turns the second `send` into a no-op. Without this,
 * every replay would pay for another LLM call.
 */
export function summarizeJobIdFor(transcriptId: string, templateId: string): string {
  return uuidV5(`job:summarize:${transcriptId}:${templateId}`);
}

/**
 * The id of the remux job a finished transcription hands on (ADR-010).
 *
 * Derived from the session, because a session has exactly one recording and that recording is
 * repackaged exactly once. Every transcription of it — the first, a retry a user asked for, an
 * operator's redrive — computes the same id, so the pg-boss singleton key collapses them into
 * one queued job instead of a queue full of attempts to redo work already done.
 */
export function remuxJobIdFor(sessionId: string): string {
  return uuidV5(`job:remux:${sessionId}`);
}
