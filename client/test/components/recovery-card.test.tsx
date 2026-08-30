import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BufferedSession } from "@/features/recording/chunk-buffer";
import { RecoveryCard } from "@/components/recording/recovery-card";
import type { RecordingState } from "@/features/recording/use-recording";
import { renderWithProviders, stubRecordingSession, useLanguage } from "./render";

/**
 * The card that offers to finish a recording nothing is taking care of any more — the half
 * meetings left behind before the session survived navigation, and anything a closed tab or a
 * crash produces from now on.
 *
 * The one rule that is not obvious: it must stand down while a recording is running. Recovering
 * replaces the protocol client, so an offer taken up mid-meeting would cut the live session loose
 * to finalize an older one — and the live session is unfinished audio too, so it is exactly the
 * kind of thing a naive offer would name.
 */

const ORPHANED: BufferedSession = {
  sessionId: "5c1a7f3e-9b2d-4c8a-8f11-2a3b4c5d6e7f",
  meetingTitle: null,
  audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
  startedAt: "2026-08-30T09:15:00.000Z",
  lastSeq: 41,
  persistedSeq: 37,
  finalized: false,
};

function renderCard(state: Partial<RecordingState>, overrides = {}) {
  const recording = stubRecordingSession({ state, ...overrides });
  renderWithProviders(<RecoveryCard />, { recording });
  return recording;
}

describe("the recovery card", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("stays away when there is nothing left over", () => {
    renderCard({ recoverable: null });
    expect(screen.queryByText("A recording was interrupted")).not.toBeInTheDocument();
  });

  it("offers to finish audio that was left on the device", () => {
    renderCard({ recoverable: ORPHANED });
    expect(screen.getByText("A recording was interrupted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload and finish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
  });

  it("delivers the leftover audio when the offer is taken up", async () => {
    const recover = vi.fn();
    renderCard({ recoverable: ORPHANED }, { recover });
    await userEvent.click(screen.getByRole("button", { name: "Upload and finish" }));
    expect(recover).toHaveBeenCalledWith(ORPHANED);
  });

  it("throws the leftover audio away only when asked to", async () => {
    const discardRecoverable = vi.fn();
    renderCard({ recoverable: ORPHANED }, { discardRecoverable });
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(discardRecoverable).toHaveBeenCalledWith(ORPHANED);
  });

  it("stands down while a recording is running", () => {
    renderCard({ recoverable: ORPHANED, phase: "recording" });
    expect(screen.queryByText("A recording was interrupted")).not.toBeInTheDocument();
  });

  it("stands down while a recording is paused", () => {
    renderCard({ recoverable: ORPHANED, phase: "paused" });
    expect(screen.queryByText("A recording was interrupted")).not.toBeInTheDocument();
  });

  it("cannot be taken up twice while it is already uploading", () => {
    renderCard({ recoverable: ORPHANED, phase: "finalizing" });
    expect(screen.getByRole("button", { name: "Upload and finish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });
});
