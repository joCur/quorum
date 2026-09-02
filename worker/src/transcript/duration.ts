import type { WhisperTranscriptionResponse } from "../whisper/response.js";

/**
 * How long the audio really was, according to the process that decoded it.
 *
 * `duration` is the field to believe: the backend reports the decoded length of the file, silence
 * and trailing padding included. The last segment's end is the fallback for backends that omit it,
 * and it is a lower bound rather than an equal — a recording that ends in silence has segments
 * that stop before the audio does. Reading it as a lower bound is the safe direction: it can only
 * understate the truth, so it can only ever fail to flag a discrepancy, never invent one.
 *
 * `null` means the response carried neither, which is a reconciliation that cannot happen rather
 * than a recording of zero seconds.
 */
export function audioDurationSeconds(response: WhisperTranscriptionResponse): number | null {
  if (typeof response.duration === "number" && Number.isFinite(response.duration)) {
    if (response.duration > 0) return response.duration;
  }
  const ends = (response.segments ?? [])
    .map((segment) => segment.end)
    .filter((end) => Number.isFinite(end));
  if (ends.length === 0) return null;
  const last = Math.max(...ends);
  return last > 0 ? last : null;
}
