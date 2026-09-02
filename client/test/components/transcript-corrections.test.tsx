import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MAX_SEGMENT_TEXT_LENGTH,
  TRANSCRIPT_SCHEMA_VERSION,
  type Segment,
  type Transcript,
} from "@quorum/shared";
import { TranscriptView } from "@/components/meetings/transcript-view";
import { renderWithProviders, useLanguage } from "./render";

/**
 * Correcting a transcript passage from the screen that shows it (ADR-003 §2).
 *
 * What is held here is what a user can perceive: the machine's words on screen until they change
 * them, the original still readable while they type, a mark on what they changed, a way back, and
 * their typing surviving a failed save.
 */

const SPEAKER_A = "55555555-0000-4000-8000-000000000001";
const SPEAKER_B = "55555555-0000-4000-8000-000000000002";
const FIRST = "33333333-0000-4000-8000-000000000001";

const SPOKEN = "We ship on Friday.";

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: FIRST,
    start: 12,
    end: 20,
    text: SPOKEN,
    editedText: null,
    confidence: 0.9,
    speakerId: SPEAKER_A,
    editedSpeakerId: null,
    language: null,
    words: null,
    ...overrides,
  };
}

function transcript(segments: Segment[], withSpeakers = true): Transcript {
  return {
    id: "22222222-0000-4000-8000-000000000001",
    meetingId: "11111111-0000-4000-8000-000000000001",
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "whisper",
    modelVersion: "large-v3",
    language: "en",
    recordedAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T10:06:00.000Z",
    speakers: withSpeakers
      ? [
          { id: SPEAKER_A, label: "Speaker 1", profileId: null },
          { id: SPEAKER_B, label: "Speaker 2", profileId: null },
        ]
      : [],
    segments,
  };
}

const onCorrect = vi.fn();
const onReset = vi.fn();

function renderTranscript(value: Transcript) {
  return renderWithProviders(
    <TranscriptView
      transcript={value}
      currentTime={0}
      onSeek={vi.fn()}
      onCorrect={onCorrect}
      onReset={onReset}
    />,
  );
}

const EDIT = "Correct the passage at 00:12";

describe("correcting a transcript segment", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    onCorrect.mockReset();
    onCorrect.mockResolvedValue(undefined);
    onReset.mockReset();
    onReset.mockResolvedValue(undefined);
  });

  it("shows the transcript as it was spoken until someone asks to change it", async () => {
    renderTranscript(transcript([segment()]));

    expect(screen.getByText(SPOKEN)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: EDIT }));
    expect(screen.getByRole("textbox", { name: "Corrected text" })).toHaveValue(SPOKEN);
  });

  it("keeps the machine's own words readable while they are being corrected", async () => {
    renderTranscript(transcript([segment()]));
    await userEvent.click(screen.getByRole("button", { name: EDIT }));

    const field = screen.getByRole("textbox", { name: "Corrected text" });
    await userEvent.clear(field);
    await userEvent.type(field, "We ship on Monday.");

    expect(screen.getByText("Recorded as:")).toBeInTheDocument();
    expect(screen.getByText(SPOKEN)).toBeInTheDocument();
  });

  it("sends the whole overlay when the correction is saved", async () => {
    renderTranscript(transcript([segment()]));
    await userEvent.click(screen.getByRole("button", { name: EDIT }));

    const field = screen.getByRole("textbox", { name: "Corrected text" });
    await userEvent.clear(field);
    await userEvent.type(field, "We ship on Monday.{Enter}");

    expect(onCorrect).toHaveBeenCalledWith(FIRST, {
      editedText: "We ship on Monday.",
      editedSpeakerId: SPEAKER_A,
    });
  });

  it("reassigns the speaker, carrying the text along unchanged", async () => {
    renderTranscript(transcript([segment()]));
    await userEvent.click(screen.getByRole("button", { name: EDIT }));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Speaker" }), SPEAKER_B);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onCorrect).toHaveBeenCalledWith(FIRST, {
      editedText: SPOKEN,
      editedSpeakerId: SPEAKER_B,
    });
  });

  it("offers no speaker picker for a transcript that knows no speakers", async () => {
    renderTranscript(transcript([segment({ speakerId: null })], false));
    await userEvent.click(screen.getByRole("button", { name: EDIT }));

    expect(screen.queryByRole("combobox", { name: "Speaker" })).not.toBeInTheDocument();
  });

  it("restores the machine's words on Escape without asking the server for anything", async () => {
    renderTranscript(transcript([segment()]));
    await userEvent.click(screen.getByRole("button", { name: EDIT }));
    await userEvent.type(screen.getByRole("textbox", { name: "Corrected text" }), " Or Monday.");
    await userEvent.keyboard("{Escape}");

    expect(onCorrect).not.toHaveBeenCalled();
    expect(screen.getByText(SPOKEN)).toBeInTheDocument();
  });

  it("stops at the length the server accepts, and names it", async () => {
    renderTranscript(transcript([segment()]));
    await userEvent.click(screen.getByRole("button", { name: EDIT }));

    const field = screen.getByRole("textbox", { name: "Corrected text" });
    await userEvent.clear(field);
    // Pasted rather than typed: that is where a cap can eat text unnoticed.
    await userEvent.paste("x".repeat(MAX_SEGMENT_TEXT_LENGTH + 50));

    expect(field).toHaveValue("x".repeat(MAX_SEGMENT_TEXT_LENGTH));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `at most ${String(MAX_SEGMENT_TEXT_LENGTH)} characters`,
    );
  });

  it("keeps the typed correction on screen when the save fails, and says so", async () => {
    onCorrect.mockRejectedValue(new Error("network"));
    renderTranscript(transcript([segment()]));

    await userEvent.click(screen.getByRole("button", { name: EDIT }));
    const field = screen.getByRole("textbox", { name: "Corrected text" });
    await userEvent.clear(field);
    await userEvent.type(field, "We ship on Monday.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByRole("textbox", { name: "Corrected text" })).toHaveValue(
      "We ship on Monday.",
    );
  });
});

describe("a segment that was corrected", () => {
  beforeEach(() => {
    onReset.mockReset();
    onReset.mockResolvedValue(undefined);
  });

  it("shows the correction, marked as one", () => {
    renderTranscript(transcript([segment({ editedText: "We ship on Monday." })]));

    expect(screen.getByText("We ship on Monday.")).toBeInTheDocument();
    expect(screen.queryByText(SPOKEN)).not.toBeInTheDocument();
    expect(screen.getByText("Corrected")).toBeInTheDocument();
  });

  it("shows the reassigned speaker instead of the recognized one", () => {
    renderTranscript(transcript([segment({ editedSpeakerId: SPEAKER_B })]));

    expect(screen.getByText("Speaker 2")).toBeInTheDocument();
    expect(screen.queryByText("Speaker 1")).not.toBeInTheDocument();
    expect(screen.getByText("Corrected")).toBeInTheDocument();
  });

  it("offers the way back to the original, per segment", async () => {
    renderTranscript(transcript([segment({ editedText: "We ship on Monday." })]));

    await userEvent.click(screen.getByRole("button", { name: "Restore the original wording" }));

    expect(onReset).toHaveBeenCalledWith(FIRST);
  });

  it("offers no reset on a segment nobody changed", () => {
    renderTranscript(transcript([segment()]));

    expect(
      screen.queryByRole("button", { name: "Restore the original wording" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Corrected")).not.toBeInTheDocument();
  });

  it("is available in German, from the catalog rather than from the code", async () => {
    await useLanguage("de");
    renderTranscript(transcript([segment({ editedText: "Wir liefern am Montag." })]));

    expect(screen.getByText("Korrigiert")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Ursprünglichen Wortlaut wiederherstellen" }),
    ).toBeInTheDocument();
    await useLanguage("en");
  });
});
