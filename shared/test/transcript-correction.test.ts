import { describe, expect, it } from "vitest";
import {
  isCorrected,
  isSummaryStale,
  latestCorrectionTime,
  normalizeSegmentOverlay,
  withCorrections,
  TRANSCRIPT_SCHEMA_VERSION,
  type Segment,
  type SegmentCorrection,
  type Transcript,
} from "../src/index.js";

/**
 * What counts as a correction (ADR-003 §2, ADR-010).
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

describe("the summary staleness hint", () => {
  const written = "2026-08-29T10:08:00.000Z";

  it("says nothing about a transcript nobody corrected", () => {
    expect(isSummaryStale(written, null)).toBe(false);
  });

  it("reports a correction made after the summary was written", () => {
    expect(isSummaryStale(written, "2026-08-29T11:00:00.000Z")).toBe(true);
  });

  it("stays quiet about a correction the summary already knew about", () => {
    expect(isSummaryStale(written, "2026-08-29T10:07:00.000Z")).toBe(false);
  });

  it("compares instants, not the strings they were written as", () => {
    // 11:30+02:00 is 09:30 UTC — earlier than the summary, though it sorts later as text.
    expect(isSummaryStale(written, "2026-08-29T11:30:00.000+02:00")).toBe(false);
  });

  it("takes the newest of several corrections", () => {
    expect(
      latestCorrectionTime([
        { segmentId: "a", editedText: "x", editedSpeakerId: null, updatedAt: written },
        {
          segmentId: "b",
          editedText: "y",
          editedSpeakerId: null,
          updatedAt: "2026-08-29T12:00:00.000Z",
        },
      ]),
    ).toBe("2026-08-29T12:00:00.000Z");
    expect(latestCorrectionTime([])).toBeNull();
  });
});
