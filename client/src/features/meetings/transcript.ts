import type { Segment, Transcript, Word } from "@quorum/shared";

/** Below this, a segment is marked as uncertain rather than presented as fact. */
export const LOW_CONFIDENCE = 0.5;

/**
 * Index of the segment covering `time`, or -1.
 *
 * Binary search rather than a scan: this runs on every playback tick, and a two-hour meeting is
 * thousands of segments.
 *
 * Segments are half-open (`start <= time < end`), so the boundary between two adjacent segments
 * belongs to exactly one of them and the highlight never flickers between both. A gap in the
 * timeline — silence the transcriber dropped — matches nothing, which is the honest answer.
 */
export function activeSegmentIndex(segments: readonly Segment[], time: number): number {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle] as Segment;
    if (time < segment.start) high = middle - 1;
    else if (time >= segment.end) low = middle + 1;
    else return middle;
  }
  return -1;
}

/** Index of the word being spoken within a segment, or -1 when there are no word timestamps. */
export function activeWordIndex(segment: Segment, time: number): number {
  if (!segment.words) return -1;
  return segment.words.findIndex((word) => time >= word.start && time < word.end);
}

/** The machine output unless the user corrected it (ADR-003 overlay model). */
export function displayText(segment: Segment): string {
  return segment.editedText ?? segment.text;
}

/**
 * Words of a segment for click-to-seek, but only when they still spell out the text being
 * shown. A corrected segment keeps its original word timings, so lighting them up under
 * different words would put the highlight on the wrong ones — the segment stays plain text and
 * seeks to its own start instead.
 */
export function seekableWords(segment: Segment): readonly Word[] | null {
  if (!segment.words || segment.editedText !== null) return null;
  return segment.words;
}

/** Speaker display name for a segment, honoring the user's override (ADR-003). */
export function speakerLabel(transcript: Transcript, segment: Segment): string | null {
  const speakerId = segment.editedSpeakerId ?? segment.speakerId;
  if (speakerId === null) return null;
  return transcript.speakers.find((speaker) => speaker.id === speakerId)?.label ?? null;
}

export function isLowConfidence(segment: Segment): boolean {
  return segment.confidence !== null && segment.confidence < LOW_CONFIDENCE;
}
