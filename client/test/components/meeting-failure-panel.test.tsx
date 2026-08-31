import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import {
  TRANSCRIPT_SCHEMA_VERSION,
  type Job,
  type MeetingDetail,
  type MeetingFailure,
  type SummaryTemplateView,
  SUMMARY_SCHEMA_VERSION,
} from "@quorum/shared";
import type { MeetingDetailState } from "@/features/meetings/use-meeting";
import type { TemplatesState } from "@/features/templates/use-templates";
import { renderWithProviders, useLanguage } from "./render";

/**
 * What a failed stage says to the user.
 *
 * The pipeline reports a code and a message written for logs — the message may quote whatever a
 * backend answered, English and all. This suite holds the screen to rendering the code instead:
 * a translated sentence about the user's recording, with the raw string nowhere in the document.
 */
const MEETING_ID = "11111111-0000-4000-8000-000000000001";
const TRANSCRIPT_ID = "11111111-0000-4000-8000-0000000000a1";
const TEMPLATE_ID = "11111111-0000-4000-8000-0000000000c1";
const JOB_ID = "44444444-0000-4000-8000-00000000000a";
const SPOKEN = "The home page is finished.";

/** The developer-facing string the bug used to put on screen, quoted as the pipeline writes it. */
const RAW_MESSAGE =
  'transcription backend answered 404: {"detail":"Model \'small\' is not installed locally."}';

const templateSections = [
  { id: "decisions", title: "Decisions", instruction: "List them.", format: "bullets" as const },
];

let currentDetail: MeetingDetail;

function failedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    meetingId: MEETING_ID,
    type: "transcribe",
    status: "failed",
    progress: null,
    error: { code: "TRANSCRIPTION_REJECTED", message: RAW_MESSAGE },
    resultId: null,
    createdAt: "2026-08-29T10:00:00.000Z",
    startedAt: "2026-08-29T10:01:00.000Z",
    finishedAt: "2026-08-29T10:02:00.000Z",
    ...overrides,
  };
}

function detailWithFailure(failure: MeetingFailure, jobs: Job[]): MeetingDetail {
  return {
    meeting: {
      id: MEETING_ID,
      sessionId: "11111111-0000-4000-8000-000000000002",
      title: "Website relaunch",
      status: "failed",
      audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
      createdAt: "2026-08-29T10:00:00.000Z",
      finalizedAt: "2026-08-29T10:05:00.000Z",
      durationSeconds: 60,
      language: "en",
      progress: null,
      hasAudio: true,
      failure,
    },
    // A failed summary leaves the transcript standing, which is the point of rendering the failure
    // in one panel instead of over the whole screen.
    transcript:
      failure.stage === "summarize"
        ? {
            id: TRANSCRIPT_ID,
            meetingId: MEETING_ID,
            schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
            isActive: true,
            model: "whisper",
            modelVersion: "large-v3",
            language: "en",
            recordedAt: "2026-08-29T10:00:00.000Z",
            createdAt: "2026-08-29T10:06:00.000Z",
            speakers: [],
            segments: [
              {
                id: "33333333-0000-4000-8000-000000000001",
                start: 0,
                end: 12,
                text: SPOKEN,
                editedText: null,
                confidence: 0.9,
                speakerId: null,
                editedSpeakerId: null,
                language: "en",
                words: null,
              },
            ],
          }
        : null,
    summaries: [],
    jobs,
  };
}

const template: SummaryTemplateView = {
  template: {
    id: TEMPLATE_ID,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    name: "Standard minutes",
    version: 3,
    scope: "system",
    basedOn: null,
    sections: templateSections,
    overrides: [],
    options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
  },
  resolvedSections: templateSections,
  editable: false,
  isDefault: true,
};

vi.mock("@/features/meetings/use-meeting", () => ({
  useMeeting: (): MeetingDetailState => ({
    detail: currentDetail,
    status: "ready",
    errorCode: null,
    deleting: false,
    reload: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("@/features/meetings/use-meeting-audio", () => ({
  useMeetingAudio: () => ({ url: "blob:audio", status: "ready", reload: vi.fn() }),
}));

vi.mock("@/features/templates/use-templates", () => ({
  useTemplates: (): TemplatesState =>
    ({
      templates: [template],
      status: "ready",
      errorCode: null,
      saving: false,
      reload: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      chooseDefault: vi.fn(),
    }) as unknown as TemplatesState,
}));

vi.mock("@/features/templates/use-regenerate", () => ({
  useSummaryRegeneration: () => ({
    pending: false,
    errorCode: null,
    errorMessage: null,
    start: vi.fn(),
    dismissError: vi.fn(),
  }),
}));

const { MeetingDetailRoute } = await import("@/routes/meeting-detail");

function renderDetail() {
  return renderWithProviders(
    <Routes>
      <Route path="/meetings/:meetingId" element={<MeetingDetailRoute />} />
    </Routes>,
    { route: `/meetings/${MEETING_ID}` },
  );
}

describe("failed stage", () => {
  beforeEach(async () => {
    await useLanguage("en");
  });

  afterEach(async () => {
    await useLanguage("en");
  });

  it("explains a failed transcription in the user's own terms", () => {
    currentDetail = detailWithFailure(
      { stage: "transcribe", code: "TRANSCRIPTION_REJECTED", message: RAW_MESSAGE },
      [failedJob()],
    );
    renderDetail();

    expect(screen.getByText("Transcription failed")).toBeInTheDocument();
    expect(screen.getByText(/This recording could not be transcribed\./)).toBeInTheDocument();
    // The whole reason this panel exists: no part of what a backend said reaches the document.
    expect(screen.queryByText(RAW_MESSAGE)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("404");
    expect(document.body.textContent).not.toContain("Model 'small'");
  });

  it("keeps the code and the reference for support, one click down", async () => {
    currentDetail = detailWithFailure(
      { stage: "transcribe", code: "TRANSCRIPTION_REJECTED", message: RAW_MESSAGE },
      [failedJob()],
    );
    renderDetail();

    const disclosure = screen.getByText("Technical details");
    await userEvent.click(disclosure);
    expect(screen.getByText("Error code: TRANSCRIPTION_REJECTED")).toBeInTheDocument();
    expect(screen.getByText(`Reference: ${JOB_ID}`)).toBeInTheDocument();
  });

  it("falls back to a generic sentence for a code it does not know", () => {
    currentDetail = detailWithFailure(
      { stage: "transcribe", code: "SOMETHING_NEW", message: RAW_MESSAGE },
      [failedJob({ error: { code: "SOMETHING_NEW", message: RAW_MESSAGE } })],
    );
    renderDetail();

    expect(screen.getByText(/This meeting could not be processed\./)).toBeInTheDocument();
    expect(screen.queryByText(RAW_MESSAGE)).not.toBeInTheDocument();
  });

  it("reports a failed summary without touching the transcript", () => {
    currentDetail = detailWithFailure(
      { stage: "summarize", code: "SUMMARY_UNAVAILABLE", message: "summary backend answered 503" },
      [failedJob({ type: "summarize", error: { code: "SUMMARY_UNAVAILABLE", message: "503" } })],
    );
    renderDetail();

    expect(screen.getByText("Summary failed")).toBeInTheDocument();
    expect(screen.getByText(/Summarizing is not possible right now\./)).toBeInTheDocument();
    expect(screen.getByText(SPOKEN)).toBeInTheDocument();
  });

  it("speaks German to a German browser", async () => {
    await useLanguage("de");
    currentDetail = detailWithFailure(
      { stage: "transcribe", code: "TRANSCRIPTION_REJECTED", message: RAW_MESSAGE },
      [failedJob()],
    );
    renderDetail();

    expect(
      screen.getByText(/Diese Aufnahme konnte nicht transkribiert werden\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(RAW_MESSAGE)).not.toBeInTheDocument();
  });
});
