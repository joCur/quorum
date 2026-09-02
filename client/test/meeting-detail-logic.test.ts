import { describe, expect, it } from "vitest";
import {
  SUMMARY_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptSchema,
  type Meeting,
  type MeetingDetail,
  type Segment,
  type Summary,
  type Transcript,
} from "@quorum/shared";
import { isPipelineComplete, pipelineSteps } from "@/features/meetings/pipeline";
import {
  activeSegmentIndex,
  activeWordIndex,
  displayText,
  isLowConfidence,
  seekableWords,
  speakerLabel,
} from "@/features/meetings/transcript";
import { summaryToMarkdown } from "@/features/meetings/summary-markdown";

const MEETING_ID = "11111111-0000-4000-8000-000000000001";
const SPEAKER_ID = "22222222-0000-4000-8000-000000000001";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: MEETING_ID,
    sessionId: "11111111-0000-4000-8000-000000000002",
    title: "Weekly sync",
    status: "ready",
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    createdAt: "2026-08-29T10:00:00.000Z",
    finalizedAt: "2026-08-29T10:05:00.000Z",
    durationSeconds: 120,
    language: "en",
    progress: null,
    hasAudio: true,
    failure: null,
    ...overrides,
  };
}

function detail(overrides: Partial<Meeting> = {}): MeetingDetail {
  return {
    meeting: meeting(overrides),
    transcript: null,
    summaries: [],
    jobs: [],
    transcriptCorrectedAt: null,
  };
}

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: "33333333-0000-4000-8000-000000000001",
    start: 0,
    end: 10,
    text: "Welcome everyone.",
    editedText: null,
    confidence: 0.9,
    speakerId: null,
    editedSpeakerId: null,
    language: null,
    words: null,
    ...overrides,
  };
}

function states(input: MeetingDetail): string[] {
  return pipelineSteps(input).map((step) => step.state);
}

describe("pipeline stepper", () => {
  it("marks the upload stage active while the recording is open", () => {
    expect(states(detail({ status: "recording" }))).toEqual([
      "active",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("walks the stages forward as the meeting progresses", () => {
    expect(states(detail({ status: "queued" }))).toEqual([
      "done",
      "active",
      "upcoming",
      "upcoming",
    ]);
    expect(states(detail({ status: "transcribing" }))).toEqual([
      "done",
      "done",
      "active",
      "upcoming",
    ]);
    expect(states(detail({ status: "summarizing" }))).toEqual(["done", "done", "done", "active"]);
  });

  it("marks everything done once the meeting is ready", () => {
    const ready = detail({ status: "ready" });
    expect(states(ready)).toEqual(["done", "done", "done", "done"]);
    expect(isPipelineComplete(ready)).toBe(true);
  });

  it("marks the failed stage and leaves the earlier ones done", () => {
    const failed = detail({
      status: "failed",
      failure: { stage: "transcribe", code: "AUDIO_DECODE_FAILED", message: "No audio." },
    });
    expect(states(failed)).toEqual(["done", "done", "failed", "upcoming"]);
    expect(isPipelineComplete(failed)).toBe(false);
  });

  it("puts a summary failure after a successful transcription", () => {
    const failed = detail({
      status: "failed",
      failure: { stage: "summarize", code: "LLM_UNAVAILABLE", message: "No model." },
    });
    expect(states(failed)).toEqual(["done", "done", "done", "failed"]);
  });

  it("carries a reported progress number and never invents one", () => {
    const withProgress = pipelineSteps(detail({ status: "transcribing", progress: 0.4 }));
    expect(withProgress[2]).toMatchObject({ state: "active", progress: 0.4 });
    const without = pipelineSteps(detail({ status: "transcribing" }));
    expect(without[2]).toMatchObject({ state: "active", progress: null });
  });
});

describe("transcript synchronization", () => {
  const segments: Segment[] = [
    segment({ id: "33333333-0000-4000-8000-000000000001", start: 0, end: 10 }),
    segment({ id: "33333333-0000-4000-8000-000000000002", start: 10, end: 20 }),
    // A gap: 20–25 is silence no segment covers.
    segment({ id: "33333333-0000-4000-8000-000000000003", start: 25, end: 30 }),
  ];

  it("finds the segment covering a moment", () => {
    expect(activeSegmentIndex(segments, 5)).toBe(0);
    expect(activeSegmentIndex(segments, 15)).toBe(1);
    expect(activeSegmentIndex(segments, 27)).toBe(2);
  });

  it("gives a shared boundary to exactly one segment", () => {
    // Half-open intervals: 10 belongs to the second segment only, so the highlight cannot
    // flicker between two segments at the seam.
    expect(activeSegmentIndex(segments, 10)).toBe(1);
  });

  it("matches nothing in a gap or outside the recording", () => {
    expect(activeSegmentIndex(segments, 22)).toBe(-1);
    expect(activeSegmentIndex(segments, 99)).toBe(-1);
    expect(activeSegmentIndex([], 1)).toBe(-1);
  });

  it("finds the word being spoken", () => {
    const withWords = segment({
      words: [
        { word: "Welcome", start: 0, end: 1 },
        { word: "everyone", start: 1, end: 2 },
      ],
    });
    expect(activeWordIndex(withWords, 1.5)).toBe(1);
    expect(activeWordIndex(withWords, 5)).toBe(-1);
    expect(activeWordIndex(segment(), 1)).toBe(-1);
  });

  it("shows the user's correction over the machine output", () => {
    expect(displayText(segment({ editedText: "Welcome, everyone!" }))).toBe("Welcome, everyone!");
    expect(displayText(segment())).toBe("Welcome everyone.");
  });

  it("stops offering word-level seeking once a segment was corrected", () => {
    // The word timings still describe the original wording, so highlighting them under the
    // corrected text would land on the wrong words.
    const words = [{ word: "Welcome", start: 0, end: 1 }];
    expect(seekableWords(segment({ words }))).toEqual(words);
    expect(seekableWords(segment({ words, editedText: "Hello" }))).toBeNull();
  });

  it("prefers the user's speaker assignment", () => {
    const transcript = {
      speakers: [
        { id: SPEAKER_ID, label: "Jonas", profileId: null },
        {
          id: "22222222-0000-4000-8000-000000000002",
          label: "Speaker 2",
          profileId: null,
        },
      ],
    } as Transcript;

    expect(
      speakerLabel(
        transcript,
        segment({ speakerId: "22222222-0000-4000-8000-000000000002", editedSpeakerId: SPEAKER_ID }),
      ),
    ).toBe("Jonas");
    expect(speakerLabel(transcript, segment())).toBeNull();
  });

  it("marks a segment the transcriber was unsure about", () => {
    expect(isLowConfidence(segment({ confidence: 0.3 }))).toBe(true);
    expect(isLowConfidence(segment({ confidence: 0.9 }))).toBe(false);
    // No confidence reported is not the same as low confidence.
    expect(isLowConfidence(segment({ confidence: null }))).toBe(false);
  });
});

describe("summary export", () => {
  it("renders each format as the Markdown people paste elsewhere", () => {
    const summary: Summary = {
      id: "44444444-0000-4000-8000-000000000001",
      meetingId: MEETING_ID,
      transcriptId: "55555555-0000-4000-8000-000000000001",
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      isActive: true,
      templateSnapshot: {
        templateId: "66666666-0000-4000-8000-000000000001",
        templateVersion: 2,
        resolvedSections: [],
        options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
      },
      model: "gpt-oss",
      promptVersion: "1",
      generatedTitle: null,
      createdAt: "2026-08-29T10:08:00.000Z",
      sections: [
        {
          sectionId: "overview",
          title: "Overview",
          format: "prose",
          content: ["First paragraph.", "Second paragraph."],
          sourceSegmentIds: null,
        },
        {
          sectionId: "decisions",
          title: "Decisions",
          format: "bullets",
          content: ["Ship it.", "Revisit pricing."],
          sourceSegmentIds: null,
        },
      ],
    };

    expect(summaryToMarkdown(summary)).toBe(
      [
        "## Overview",
        "",
        "First paragraph.",
        "",
        "Second paragraph.",
        "",
        "## Decisions",
        "",
        "- Ship it.",
        "- Revisit pricing.",
      ].join("\n"),
    );
  });
});

describe("transcript schema fixture", () => {
  it("keeps the test segments valid against the shared contract", () => {
    // Guards the fixtures above: a segment shape that drifted from shared/src would make every
    // assertion here meaningless, so the fixture is validated by the real schema.
    const transcript: Transcript = {
      id: "55555555-0000-4000-8000-000000000001",
      meetingId: MEETING_ID,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      isActive: true,
      model: "whisper",
      modelVersion: "large-v3",
      language: "en",
      recordedAt: "2026-08-29T10:00:00.000Z",
      createdAt: "2026-08-29T10:06:00.000Z",
      speakers: [],
      segments: [segment()],
    };
    expect(TranscriptSchema.parse(transcript).segments).toHaveLength(1);
  });
});
