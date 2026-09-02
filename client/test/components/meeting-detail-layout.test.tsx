import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import {
  SUMMARY_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type MeetingDetail,
  type SummaryTemplateView,
} from "@quorum/shared";
import type { MeetingDetailState } from "@/features/meetings/use-meeting";
import type { TemplatesState } from "@/features/templates/use-templates";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The meeting detail with neither an API nor an audio element behind it: the data hooks are
 * replaced so the test can hold one finished meeting still and ask what the screen makes of it.
 *
 * What matters here is the shape the v2 screen settled on. Both halves are on the page at once —
 * the transcript and the summary are no longer two tabs taking turns, so nothing is unmounted and
 * a narrow screen only chooses which of the two it shows.
 */
const MEETING_ID = "11111111-0000-4000-8000-000000000001";
const TRANSCRIPT_ID = "11111111-0000-4000-8000-0000000000a1";
const SUMMARY_ID = "11111111-0000-4000-8000-0000000000b1";
const TEMPLATE_ID = "11111111-0000-4000-8000-0000000000c1";
const SEGMENT_ID = "33333333-0000-4000-8000-000000000001";

const SPOKEN = "The home page is finished.";
const SECTION_TITLE = "Decisions";
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const templateSections = [
  { id: "decisions", title: SECTION_TITLE, instruction: "List them.", format: "bullets" as const },
];

function detail(): MeetingDetail {
  return {
    meeting: {
      id: MEETING_ID,
      sessionId: "11111111-0000-4000-8000-000000000002",
      title: "Website relaunch",
      status: "ready",
      audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
      createdAt: "2026-08-29T10:00:00.000Z",
      finalizedAt: "2026-08-29T10:05:00.000Z",
      durationSeconds: 60,
      language: "en",
      progress: null,
      hasAudio: true,
      failure: null,
    },
    transcript: {
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
          id: SEGMENT_ID,
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
    },
    summaries: [
      {
        id: SUMMARY_ID,
        meetingId: MEETING_ID,
        transcriptId: TRANSCRIPT_ID,
        schemaVersion: SUMMARY_SCHEMA_VERSION,
        isActive: true,
        templateSnapshot: {
          templateId: TEMPLATE_ID,
          templateVersion: 3,
          resolvedSections: templateSections,
          options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
        },
        model: "llama",
        promptVersion: "1",
        generatedTitle: null,
        // Relative to now, because the attribution line reports how long ago it was written.
        createdAt: TWO_HOURS_AGO,
        sections: [
          {
            sectionId: "decisions",
            title: SECTION_TITLE,
            format: "bullets",
            content: ["The mobile navigation is simplified."],
            sourceSegmentIds: null,
          },
        ],
      },
    ],
    jobs: [],
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

/** The meeting the screen is given; a test that needs a different one assigns it in place. */
let currentDetail: MeetingDetail = detail();

vi.mock("@/features/meetings/use-meeting", () => ({
  useMeeting: (): MeetingDetailState => ({
    detail: currentDetail,
    status: "ready",
    errorCode: null,
    deleting: false,
    reload: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    correct: vi.fn(),
    reset: vi.fn(),
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

const { MeetingDetailRoute } = await import("@/routes/meeting-detail");

function renderDetail() {
  return renderWithProviders(
    <Routes>
      <Route path="/meetings/:meetingId" element={<MeetingDetailRoute />} />
    </Routes>,
    { route: `/meetings/${MEETING_ID}` },
  );
}

describe("meeting detail layout", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    currentDetail = detail();
  });

  it("puts the transcript and the summary on the page together", () => {
    // The two halves stand side by side on a wide screen, so both are mounted and neither waits
    // for a click to exist. A tab strip would be the wrong promise: nothing here is hidden.
    renderDetail();
    expect(screen.getByText(SPOKEN)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: SECTION_TITLE })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("names both halves so they can be told apart", () => {
    renderDetail();
    expect(screen.getByRole("heading", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
  });

  it("offers the summary first in the switch a narrow screen uses", async () => {
    // Below the shell breakpoint only one half is shown, and the summary is the one people open a
    // finished meeting for. The switch says which is showing; both stay mounted either way.
    renderDetail();
    const group = screen.getByRole("group", { name: "Meeting content" });
    const [summary, transcript] = within(group).getAllByRole("button");

    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Summary", "Transcript"]);
    expect(summary).toHaveAttribute("aria-pressed", "true");
    expect(transcript).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(transcript!);
    expect(transcript).toHaveAttribute("aria-pressed", "true");
    expect(summary).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(SPOKEN)).toBeInTheDocument();
  });

  it("carries the playback controls the design names", () => {
    // The player is a pill bar now: a round play button, a seekable track, ±10s and the rate.
    renderDetail();
    const player = screen.getByRole("group", { name: "Playback" });
    expect(within(player).getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(within(player).getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    expect(within(player).getByRole("button", { name: "Back 10 seconds" })).toBeInTheDocument();
    expect(within(player).getByRole("button", { name: "Forward 10 seconds" })).toBeInTheDocument();
    expect(within(player).getByRole("button", { name: "Playback speed: 1×" })).toBeInTheDocument();
  });

  it("keeps the template choice and the regenerate action with the summary", () => {
    // The picker is named by its label rather than showing one: in a rail this narrow a caption
    // above the field costs a row to say what the value on the control already says.
    renderDetail();
    expect(screen.getByLabelText("Template")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  it("says nothing about a state that has nothing left to report", () => {
    // A finished meeting carries no status chip: the stepper reports the work while there is any,
    // and a standing "Ready" would be the screen talking about itself (STATES.md §9).
    renderDetail();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
  });

  it("says where the summary came from in one line, right above the picker", () => {
    // Template, version and freshness are one fact about one thing, so they are one sentence —
    // and it sits directly above the control that can replace what it describes.
    renderDetail();
    const attribution = screen.getByText(/Made with Standard minutes/);
    expect(attribution).toHaveTextContent("Template version 3");
    expect(attribution).toHaveTextContent("2 hours ago");

    const picker = screen.getByLabelText("Template");
    expect(attribution.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

/**
 * The summary against a transcript that has been corrected since (ADR-010).
 *
 * The note is the whole feature here: no re-summarizing, no warning banner, just the summary
 * saying it describes wording that has since changed.
 */
describe("a summary older than the corrections", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("says nothing while the transcript stands as it was transcribed", () => {
    currentDetail = detail();
    renderDetail();

    expect(screen.queryByText(/corrected after this summary/)).not.toBeInTheDocument();
  });

  it("notes a correction made after the summary was written", () => {
    currentDetail = { ...detail(), transcriptCorrectedAt: new Date().toISOString() };
    renderDetail();

    expect(
      screen.getByText("The transcript was corrected after this summary was written."),
    ).toBeInTheDocument();
  });

  it("stays quiet about a correction the summary already knew about", () => {
    currentDetail = {
      ...detail(),
      transcriptCorrectedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    };
    renderDetail();

    expect(screen.queryByText(/corrected after this summary/)).not.toBeInTheDocument();
  });
});
