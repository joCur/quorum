import { z } from "zod";
import { SegmentSchema, type Segment, type Transcript } from "./transcript.js";

/**
 * User corrections to a transcript segment (ADR-003 §2, ADR-011).
 *
 * A correction is an overlay: the machine's `text` and `speakerId` are never touched, and the two
 * `edited*` fields beside them carry what the user says it should read instead. The overlay is
 * stored as its own row, so clearing a correction is a deletion and the original is recoverable by
 * construction rather than by careful bookkeeping.
 *
 * The rules for what counts as a correction live here rather than in the endpoint, because the
 * client decides whether to offer "reset to the original" from the same facts the server decides
 * whether to keep a row from. Two implementations of that would drift.
 */

/**
 * Cap on a corrected segment's text.
 *
 * A segment is a sentence or two of speech, and the machine output it replaces is bounded by what
 * the transcriber emits. The bound is generous against that — a user rewriting a garbled passage
 * may well need more words than were recognized — and exists to keep a single segment from
 * becoming a document.
 */
export const MAX_SEGMENT_TEXT_LENGTH = 5_000;

/**
 * The overlay itself: what a user says a segment should read, and who they say said it.
 *
 * `null` means "no correction of this kind", not "empty". A segment whose text was corrected and
 * whose speaker was not carries a text and a null speaker.
 */
export const SegmentOverlaySchema = z.object({
  editedText: z.string().max(MAX_SEGMENT_TEXT_LENGTH).nullable(),
  /** References `Transcript.speakers[].id`; the server refuses a speaker the transcript lacks. */
  editedSpeakerId: z.string().uuid().nullable(),
});

/**
 * What a client sends to correct one segment.
 *
 * Both fields are required. An absent field is a malformed request rather than "leave that one
 * alone", so a client cannot drop a speaker override by forgetting to mention it — the same rule
 * the rename endpoint applies to a title.
 */
export const SetSegmentCorrectionRequestSchema = SegmentOverlaySchema;

/** A stored overlay, as the server hands it back and as the deletion cascade counts it. */
export const SegmentCorrectionSchema = SegmentOverlaySchema.extend({
  segmentId: z.string().uuid(),
  /** When this correction was last written. */
  updatedAt: z.string().datetime(),
});

/**
 * The answer to setting or clearing a correction: the segment as it now reads.
 *
 * It is built from what the store did, never from what the request asked for — a write that did
 * not land must not come back described as one that did. Returning the merged segment lets the
 * screen update the meeting it already holds instead of re-fetching a transcript and a summary
 * that did not change, visibly, under someone who is reading them.
 */
export const SegmentCorrectionResponseSchema = z.object({
  segment: SegmentSchema,
});

export type SegmentOverlay = z.infer<typeof SegmentOverlaySchema>;
export type SetSegmentCorrectionRequest = z.infer<typeof SetSegmentCorrectionRequestSchema>;
export type SegmentCorrection = z.infer<typeof SegmentCorrectionSchema>;
export type SegmentCorrectionResponse = z.infer<typeof SegmentCorrectionResponseSchema>;

/**
 * The overlay worth storing for a segment, or `null` when there is nothing to store.
 *
 * Three things collapse to "no correction", and all three matter:
 *
 * - Text that is blank. A user cannot blank a segment; emptying the field restores the original,
 *   which is also the only sensible reading of "I deleted everything I typed".
 * - Text identical to the machine output. Marking that segment as corrected would put a badge on
 *   a segment nobody changed, and offer a reset that resets to what is already there.
 * - A speaker equal to the machine's own assignment. Same reason.
 *
 * When both fall away the whole overlay does, and the caller deletes the row rather than storing a
 * pair of nulls that would read as a correction to everything that counts rows.
 */
export function normalizeSegmentOverlay(
  segment: Segment,
  overlay: SegmentOverlay,
): SegmentOverlay | null {
  const trimmed = overlay.editedText?.trim() ?? "";
  const editedText = trimmed === "" || trimmed === segment.text.trim() ? null : trimmed;
  const editedSpeakerId =
    overlay.editedSpeakerId === null || overlay.editedSpeakerId === segment.speakerId
      ? null
      : overlay.editedSpeakerId;

  if (editedText === null && editedSpeakerId === null) return null;
  return { editedText, editedSpeakerId };
}

/** True when a segment carries a user correction of either kind. */
export function isCorrected(segment: Segment): boolean {
  return segment.editedText !== null || segment.editedSpeakerId !== null;
}

/**
 * The transcript as the user has corrected it.
 *
 * The overlay rows are the single source of truth for the two `edited*` fields: a segment with no
 * row is reset to uncorrected regardless of what the stored document happens to hold. That is what
 * makes clearing a correction a deletion rather than a second kind of write.
 */
export function withCorrections(
  transcript: Transcript,
  corrections: readonly SegmentCorrection[],
): Transcript {
  if (corrections.length === 0 && transcript.segments.every((segment) => !isCorrected(segment))) {
    return transcript;
  }
  const bySegment = new Map(corrections.map((correction) => [correction.segmentId, correction]));
  return {
    ...transcript,
    segments: transcript.segments.map((segment) => {
      const correction = bySegment.get(segment.id);
      return {
        ...segment,
        editedText: correction?.editedText ?? null,
        editedSpeakerId: correction?.editedSpeakerId ?? null,
      };
    }),
  };
}

/**
 * True when any segment of this transcript carries a correction.
 *
 * This, and not a comparison of timestamps, is what tells a summary it describes wording the user
 * has since changed (ADR-011). Every summary in this cut is written from the transcript the
 * machine produced — the pipeline never reads the overlay — so the question is not *when* a
 * correction was made relative to the summary. It is whether the transcript on screen still reads
 * the way the summary's source did.
 *
 * A time comparison answers that wrongly in both directions: regenerating a summary would clear
 * the note although the new summary saw the original wording just like the old one, and resetting
 * one of several corrections would clear it although the others still stand.
 */
export function hasCorrections(transcript: Transcript): boolean {
  return transcript.segments.some(isCorrected);
}
