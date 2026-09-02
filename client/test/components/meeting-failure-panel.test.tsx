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
import type * as MeetingsApi from "@/features/meetings/api";
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

/** Stands in for the retry request, so the panel's action can be driven without a server. */
const retryTranscription = vi.hoisted(() => vi.fn());
const reload = vi.hoisted(() => vi.fn());

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
    transcriptCorrectedAt: null,
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
    reload,
    remove: vi.fn(),
    rename: vi.fn(),
  }),
}));

vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ accessToken: "stub" }),
}));

// Only the request is replaced. `MeetingApiError` stays the real one, because the panel's copy
// for a refusal is chosen from the code it carries.
vi.mock("@/features/meetings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof MeetingsApi>()),
  retryTranscription,
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
      rename: vi.fn(),
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

const { MeetingApiError } = await import("@/features/meetings/api");
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
    retryTranscription.mockReset();
    reload.mockReset();
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
    // The status is matched on word boundaries, the way the end-to-end suite has to match it: the
    // panel prints a job id, and hex digits would otherwise make the needle find itself.
    expect(screen.queryByText(RAW_MESSAGE)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b404\b/);
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

/**
 * The way out of a failed transcription.
 *
 * The action is offered exactly where the server would accept it, which is the property worth
 * holding: a button that is guaranteed to be refused invites the user to keep pressing something
 * that cannot work.
 */
describe("retrying a failed transcription", () => {
  const UNAVAILABLE = { code: "TRANSCRIPTION_UNAVAILABLE", message: RAW_MESSAGE };

  beforeEach(async () => {
    await useLanguage("en");
    retryTranscription.mockReset();
    reload.mockReset();
  });

  afterEach(async () => {
    await useLanguage("en");
  });

  function renderRetryableFailure() {
    currentDetail = detailWithFailure({ stage: "transcribe", ...UNAVAILABLE }, [
      failedJob({ error: UNAVAILABLE }),
    ]);
    return renderDetail();
  }

  it("offers the action for a failure another attempt could survive", () => {
    renderRetryableFailure();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("does not offer it for a failure repeating cannot undo", () => {
    currentDetail = detailWithFailure(
      { stage: "transcribe", code: "AUDIO_DECODE_FAILED", message: RAW_MESSAGE },
      [failedJob({ error: { code: "AUDIO_DECODE_FAILED", message: RAW_MESSAGE } })],
    );
    renderDetail();

    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("does not offer it for a code this build does not know", () => {
    currentDetail = detailWithFailure(
      { stage: "transcribe", code: "SOMETHING_NEW", message: RAW_MESSAGE },
      [failedJob({ error: { code: "SOMETHING_NEW", message: RAW_MESSAGE } })],
    );
    renderDetail();

    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("asks for the transcription again and refreshes the meeting", async () => {
    retryTranscription.mockResolvedValue({ job: failedJob({ status: "queued", error: null }) });
    renderRetryableFailure();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retryTranscription).toHaveBeenCalledWith(MEETING_ID, { accessToken: "stub" });
    // The reload is the whole follow-up: an accepted retry changes the meeting's own state, so
    // the screen only has to ask again and the detail timer takes over from there.
    expect(reload).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  });

  /**
   * The deadlock the held flag produced.
   *
   * A retry of a job that fails again quickly can be back in the failed state before the reload
   * that followed the click returns. The panel then never unmounts, and a `pending` flag that is
   * only cleared on refusal would leave the button disabled on "Starting…" with no way back. The
   * wait is a question about the data instead: it lasts while the failure on screen is the one
   * that was clicked on, and a newer one ends it.
   */
  it("offers the action again when the retried job has failed once more", async () => {
    let resolveRetry: (value: unknown) => void = () => undefined;
    retryTranscription.mockReturnValue(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    const { rerender } = renderRetryableFailure();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();

    // The reload comes back with a *newer* failure of the same job — the retry ran and failed.
    currentDetail = detailWithFailure({ stage: "transcribe", ...UNAVAILABLE }, [
      failedJob({ error: UNAVAILABLE, finishedAt: "2026-08-29T10:20:00.000Z" }),
    ]);
    resolveRetry({ job: failedJob({ status: "queued", error: null }) });
    rerender(
      <Routes>
        <Route path="/meetings/:meetingId" element={<MeetingDetailRoute />} />
      </Routes>,
    );

    expect(await screen.findByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("says why a refusal happened, in the user's own terms", async () => {
    retryTranscription.mockRejectedValue(
      new MeetingApiError(409, "transcription_in_progress", "This meeting is already running."),
    );
    renderRetryableFailure();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This meeting is already being transcribed.",
    );
    // Nothing changed, so the action is offered again rather than left disabled.
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("names the limit when the retry allowance is spent", async () => {
    retryTranscription.mockRejectedValue(
      new MeetingApiError(429, "limit.request_rate_exceeded", "Too many requests."),
    );
    renderRetryableFailure();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many requests in a short time/);
  });

  it("speaks German to a German browser", async () => {
    await useLanguage("de");
    renderRetryableFailure();

    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeEnabled();
  });
});
