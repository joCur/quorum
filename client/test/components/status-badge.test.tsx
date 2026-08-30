import { beforeAll, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { MeetingStatus } from "@quorum/shared";
import { StatusBadge } from "@/components/meetings/status-badge";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The badge is how a meeting's pipeline state reaches the user, and it is the single place where
 * a wrong mapping is invisible to every other kind of test: the list renders, the detail renders,
 * nothing throws, and the meeting simply claims to be in a state it is not in.
 */
describe("meeting status badge", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  const CASES: readonly { status: MeetingStatus; label: string }[] = [
    { status: "recording", label: "Recording" },
    { status: "queued", label: "Queued" },
    { status: "transcribing", label: "Transcribing" },
    { status: "summarizing", label: "Summarizing" },
    { status: "ready", label: "Ready" },
    { status: "failed", label: "Failed" },
  ];

  it.each(CASES)("names the $status state in words", ({ status, label }) => {
    renderWithProviders(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("gives every state its own label", () => {
    // Two stages sharing a label would read as one state to the user even though the pipeline
    // distinguishes them — the kind of thing a per-case assertion above cannot notice.
    const labels = CASES.map((entry) => {
      const { unmount } = renderWithProviders(<StatusBadge status={entry.status} />);
      const text = screen.getByText(entry.label).textContent;
      unmount();
      return text;
    });
    expect(new Set(labels).size).toBe(CASES.length);
  });

  it("carries a shape alongside the color in every state", () => {
    // STATES.md §8: state is never conveyed by color alone. Every badge has a decorative mark —
    // an icon, or the breathing dot for a live recording — next to its label.
    for (const entry of CASES) {
      const { container, unmount } = renderWithProviders(<StatusBadge status={entry.status} />);
      expect(
        container.querySelectorAll('[aria-hidden="true"]').length,
        `${entry.status} has no non-color marker`,
      ).toBeGreaterThan(0);
      unmount();
    }
  });

  it("marks the live recording with the breathing dot, not an icon", () => {
    // The same signal the recording screen uses, so "this is live" reads identically wherever it
    // appears — and the one state whose marker is not a lucide icon.
    const { container } = renderWithProviders(<StatusBadge status="recording" />);
    expect(container.querySelector(".animate-recording-pulse")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("translates the state rather than hard-coding it", async () => {
    await useLanguage("de");
    renderWithProviders(<StatusBadge status="ready" />);
    expect(screen.getByText("Fertig")).toBeInTheDocument();
    await useLanguage("en");
  });
});
