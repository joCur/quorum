import { describe, expect, it } from "vitest";
import {
  hasCorrections,
  isCorrected,
  normalizeSegmentOverlay,
  withCorrections,
  TRANSCRIPT_SCHEMA_VERSION,
  type Segment,
  type SegmentCorrection,
  type Transcript,
} from "../src/index.js";

/**
 * What counts as a correction (ADR-003 §2, ADR-011).
 *
 * These rules decide two things a user can see: whether a segment wears the "corrected" marker
 * with a reset beside it, and whether a row exists at all. Client and server both read them from
 * here, so this is where they are held.
 */

const SPEAKER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SPEAKER_B = "aaaaaaaa-0000-4000-8000-000000000002";

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: "dddddddd-0000-4000-8000-000000000001",
    start: 0,
    end: 4,
    text: "We ship on Friday.",
    editedText: null,
    confidence: 0.9,
    speakerId: SPEAKER_A,
    editedSpeakerId: null,
    language: null,
    words: null,
    ...overrides,
  };
}

function transcript(segments: Segment[]): Transcript {
  return {
    id: "cccccccc-0000-4000-8000-000000000001",
    meetingId: "aaaaaaaa-0000-4000-8000-000000000009",
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "whisper",
    modelVersion: "large-v3",
    language: "en",
    recordedAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T10:06:00.000Z",
    speakers: [
      { id: SPEAKER_A, label: "Speaker 1", profileId: null },
      { id: SPEAKER_B, label: "Speaker 2", profileId: null },
    ],
    segments,
  };
}

describe("normalizing a segment overlay", () => {
  it("keeps corrected text, trimmed", () => {
    expect(
      normalizeSegmentOverlay(segment(), {
        editedText: "  We ship on Monday.  ",
        editedSpeakerId: null,
      }),
    ).toEqual({ editedText: "We ship on Monday.", editedSpeakerId: null });
  });

  it("keeps a speaker the user reassigned", () => {
    expect(
      normalizeSegmentOverlay(segment(), { editedText: null, editedSpeakerId: SPEAKER_B }),
    ).toEqual({ editedText: null, editedSpeakerId: SPEAKER_B });
  });

  it("treats text the user emptied as no correction, so the original comes back", () => {
    expect(
      normalizeSegmentOverlay(segment(), { editedText: "   ", editedSpeakerId: null }),
    ).toBeNull();
  });

  it("does not record the machine's own words as a correction", () => {
    expect(
      normalizeSegmentOverlay(segment(), {
        editedText: "We ship on Friday.",
        editedSpeakerId: null,
      }),
    ).toBeNull();
  });

  it("does not record the machine's own speaker as a reassignment", () => {
    expect(
      normalizeSegmentOverlay(segment(), { editedText: null, editedSpeakerId: SPEAKER_A }),
    ).toBeNull();
  });

  it("keeps a text correction when only the speaker fell away", () => {
    expect(
      normalizeSegmentOverlay(segment(), {
        editedText: "We ship on Monday.",
        editedSpeakerId: SPEAKER_A,
      }),
    ).toEqual({ editedText: "We ship on Monday.", editedSpeakerId: null });
  });

  it("assigns a speaker to a segment diarization left unassigned", () => {
    expect(
      normalizeSegmentOverlay(segment({ speakerId: null }), {
        editedText: null,
        editedSpeakerId: SPEAKER_B,
      }),
    ).toEqual({ editedText: null, editedSpeakerId: SPEAKER_B });
  });
});

describe("applying corrections to a transcript", () => {
  const first = segment();
  const second = segment({ id: "dddddddd-0000-4000-8000-000000000002", text: "Agreed." });

  const corrections: SegmentCorrection[] = [
    {
      segmentId: second.id,
      editedText: "Agreed, unanimously.",
      editedSpeakerId: SPEAKER_B,
      updatedAt: "2026-08-29T11:00:00.000Z",
    },
  ];

  it("puts the overlay on the segment it belongs to and leaves the rest alone", () => {
    const merged = withCorrections(transcript([first, second]), corrections);

    expect(merged.segments[0]?.editedText).toBeNull();
    expect(merged.segments[1]?.editedText).toBe("Agreed, unanimously.");
    expect(merged.segments[1]?.editedSpeakerId).toBe(SPEAKER_B);
  });

  it("never touches the machine output underneath", () => {
    const merged = withCorrections(transcript([first, second]), corrections);

    expect(merged.segments[1]?.text).toBe("Agreed.");
    expect(merged.segments[1]?.speakerId).toBe(SPEAKER_A);
  });

  it("clears a correction the stored document still carries but no row backs", () => {
    const stale = segment({ editedText: "an edit that was reset", editedSpeakerId: SPEAKER_B });

    const merged = withCorrections(transcript([stale]), []);

    expect(merged.segments[0]?.editedText).toBeNull();
    expect(merged.segments[0]?.editedSpeakerId).toBeNull();
  });
});

describe("what the screen reads off a segment", () => {
  it("marks a segment as corrected for either kind of overlay", () => {
    expect(isCorrected(segment())).toBe(false);
    expect(isCorrected(segment({ editedText: "changed" }))).toBe(true);
    expect(isCorrected(segment({ editedSpeakerId: SPEAKER_B }))).toBe(true);
  });
});

describe("the summary note", () => {
  const plain = segment();
  const corrected = segment({
    id: "dddddddd-0000-4000-8000-000000000002",
    editedText: "Agreed, unanimously.",
  });

  it("says nothing about a transcript nobody corrected", () => {
    expect(hasCorrections(transcript([plain]))).toBe(false);
  });

  it("reports a transcript that carries any correction at all", () => {
    expect(hasCorrections(transcript([plain, corrected]))).toBe(true);
  });

  it("counts a speaker reassignment as a correction too", () => {
    const reassigned = segment({ editedSpeakerId: SPEAKER_B });
    expect(hasCorrections(transcript([reassigned]))).toBe(true);
  });

  /*
   * The two cases a comparison against the summary's own timestamp got wrong, held here as
   * behavior rather than as a note in an ADR: the answer depends on the transcript alone, so
   * neither writing a new summary nor resetting one of several corrections can change it while a
   * correction still stands.
   */
  it("does not depend on when the summary was written", () => {
    const corrected = transcript([plain, segment({ id: "x", editedText: "changed" })]);
    expect(hasCorrections(corrected)).toBe(true);
  });

  it("still reports the transcript when only one of several corrections is reset", () => {
    const one = segment({ id: "a", editedText: "changed" });
    const two = segment({ id: "b" });
    expect(hasCorrections(transcript([one, two]))).toBe(true);
  });
});
