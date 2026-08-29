import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SCHEMA_VERSION, TranscriptSchema } from "@quorum/shared";
import { mapResponseToTranscript } from "../src/transcript/map.js";
import { segmentId, transcriptIdForJob, uuidV5 } from "../src/ids.js";
import {
  JOB_ID,
  MEETING_ID,
  VERBOSE_RESPONSE_FLAT_WORDS,
  VERBOSE_RESPONSE_WITH_WORDS,
} from "./helpers.js";

const base = {
  jobId: JOB_ID,
  meetingId: MEETING_ID,
  model: "small",
  recordedAt: "2026-08-29T10:00:00.000Z",
  createdAt: "2026-08-29T10:31:00.000Z",
};

describe("deterministic ids", () => {
  it("produces RFC 4122 version 5 UUIDs", () => {
    const id = uuidV5("anything");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("derives the same transcript id from the same job id", () => {
    expect(transcriptIdForJob(JOB_ID)).toBe(transcriptIdForJob(JOB_ID));
    expect(transcriptIdForJob(JOB_ID)).not.toBe(transcriptIdForJob(MEETING_ID));
  });
});

describe("response mapping", () => {
  it("maps a verbose response with segment words onto a valid transcript", () => {
    const transcript = mapResponseToTranscript({ ...base, response: VERBOSE_RESPONSE_WITH_WORDS });

    expect(TranscriptSchema.safeParse(transcript).success).toBe(true);
    expect(transcript.schemaVersion).toBe(TRANSCRIPT_SCHEMA_VERSION);
    expect(transcript.meetingId).toBe(MEETING_ID);
    expect(transcript.language).toBe("en");
    expect(transcript.isActive).toBe(true);
    expect(transcript.recordedAt).toBe(base.recordedAt);
    expect(transcript.segments).toHaveLength(2);

    const first = transcript.segments[0]!;
    expect(first.id).toBe(segmentId(transcript.id, 0));
    expect(first.text).toBe("Good morning everyone.");
    expect(first.words?.map((word) => word.word)).toEqual(["Good", "morning", "everyone."]);
    expect(first.words?.[0]).toEqual({ word: "Good", start: 0.12, end: 0.44 });
  });

  it("strips the leading space Whisper puts in front of every word", () => {
    const transcript = mapResponseToTranscript({
      ...base,
      response: {
        text: " Good morning",
        segments: [
          {
            start: 0,
            end: 1,
            text: " Good morning",
            words: [
              { word: " Good", start: 0, end: 0.4 },
              { word: " morning", start: 0.4, end: 0.9 },
            ],
          },
        ],
      },
    });
    expect(transcript.segments[0]!.words?.map((word) => word.word)).toEqual(["Good", "morning"]);
  });

  it("keeps the machine output immutable — no overlays and no speakers yet", () => {
    const transcript = mapResponseToTranscript({ ...base, response: VERBOSE_RESPONSE_WITH_WORDS });
    expect(transcript.speakers).toEqual([]);
    for (const segment of transcript.segments) {
      expect(segment.editedText).toBeNull();
      expect(segment.editedSpeakerId).toBeNull();
      expect(segment.speakerId).toBeNull();
    }
  });

  it("derives a 0..1 confidence from the segment log probability", () => {
    const transcript = mapResponseToTranscript({ ...base, response: VERBOSE_RESPONSE_WITH_WORDS });
    expect(transcript.segments[0]!.confidence).toBeCloseTo(0.8, 3);
    expect(transcript.segments[1]!.confidence).toBeCloseTo(Math.exp(-0.5), 6);
  });

  it("distributes a flat top-level word list across the segments without duplicates", () => {
    const transcript = mapResponseToTranscript({ ...base, response: VERBOSE_RESPONSE_FLAT_WORDS });
    const words = transcript.segments.flatMap((segment) => segment.words ?? []);

    expect(transcript.language).toBe("de");
    expect(transcript.segments[0]!.words?.map((word) => word.word)).toEqual([
      "Guten",
      "Morgen",
      "zusammen.",
    ]);
    expect(transcript.segments[1]!.words?.map((word) => word.word)).toEqual([
      "Wir",
      "fangen",
      "an.",
    ]);
    expect(words).toHaveLength(VERBOSE_RESPONSE_FLAT_WORDS.words!.length);
  });

  it("falls back to a single segment when the backend returns text only", () => {
    const transcript = mapResponseToTranscript({
      ...base,
      response: { text: " Just one line.", duration: 3, language: "en" },
    });
    expect(transcript.segments).toHaveLength(1);
    expect(transcript.segments[0]).toMatchObject({ start: 0, end: 3, text: "Just one line." });
  });

  it("produces an empty transcript rather than failing on silence", () => {
    const transcript = mapResponseToTranscript({ ...base, response: { text: "  " } });
    expect(transcript.segments).toEqual([]);
    expect(transcript.language).toBe("und");
  });

  it("records a per-segment language only when it differs from the transcript language", () => {
    const transcript = mapResponseToTranscript({
      ...base,
      response: {
        text: "x y",
        language: "en",
        segments: [
          { start: 0, end: 1, text: "x", language: "en" },
          { start: 1, end: 2, text: "y", language: "de" },
        ],
      },
    });
    expect(transcript.segments[0]!.language).toBeNull();
    expect(transcript.segments[1]!.language).toBe("de");
  });

  it("clamps negative or non-finite timestamps to zero", () => {
    const transcript = mapResponseToTranscript({
      ...base,
      response: {
        text: "x",
        segments: [
          { start: -0.5, end: -0.2, text: "x", words: [{ word: "x", start: -1, end: 2 }] },
        ],
      },
    });
    expect(transcript.segments[0]).toMatchObject({ start: 0, end: 0 });
    expect(transcript.segments[0]!.words?.[0]).toEqual({ word: "x", start: 0, end: 2 });
  });

  it("is deterministic — the same job and response map to identical output", () => {
    const first = mapResponseToTranscript({ ...base, response: VERBOSE_RESPONSE_WITH_WORDS });
    const second = mapResponseToTranscript({ ...base, response: VERBOSE_RESPONSE_WITH_WORDS });
    expect(second).toEqual(first);
  });

  it("prefers the model name the backend reports for modelVersion", () => {
    const transcript = mapResponseToTranscript({
      ...base,
      response: { ...VERBOSE_RESPONSE_WITH_WORDS, model: "Systran/faster-whisper-small" },
    });
    expect(transcript.model).toBe("small");
    expect(transcript.modelVersion).toBe("Systran/faster-whisper-small");
  });
});
