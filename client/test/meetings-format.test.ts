import { describe, expect, it } from "vitest";
import type { Meeting } from "@quorum/shared";
import { formatMeetingDate, formatMeetingDuration, meetingLabel } from "@/features/meetings/format";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "11111111-0000-4000-8000-000000000001",
    sessionId: "11111111-0000-4000-8000-000000000002",
    title: "Weekly sync",
    status: "ready",
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    createdAt: "2026-08-29T10:00:00.000Z",
    finalizedAt: "2026-08-29T10:05:00.000Z",
    durationSeconds: 3725,
    language: "en",
    progress: null,
    hasAudio: true,
    failure: null,
    ...overrides,
  };
}

describe("meeting formatting", () => {
  it("formats the recording date in the active language", () => {
    const english = formatMeetingDate("2026-08-29T10:00:00.000Z", "en-US");
    const german = formatMeetingDate("2026-08-29T10:00:00.000Z", "de-DE");
    expect(english).toContain("29");
    expect(german).toContain("29");
    // The point of passing the locale through is that the two differ.
    expect(english).not.toBe(german);
  });

  it("survives a date it cannot read instead of rendering 'Invalid Date'", () => {
    expect(formatMeetingDate("not a date", "en-US")).toBe("");
  });

  it("formats the duration past an hour", () => {
    expect(formatMeetingDuration(meeting())).toBe("1:02:05");
  });

  it("reports no duration while the length is unknown", () => {
    // Length comes from the transcript, so it is absent for everything still being processed.
    expect(formatMeetingDuration(meeting({ durationSeconds: null }))).toBeNull();
  });

  it("names the meeting for the delete confirmation", () => {
    const label = meetingLabel(meeting(), "en-US", "Untitled meeting");
    expect(label.startsWith("Weekly sync — ")).toBe(true);
  });

  it("identifies an untitled meeting by its date", () => {
    const label = meetingLabel(meeting({ title: null }), "en-US", "Untitled meeting");
    expect(label.startsWith("Untitled meeting — ")).toBe(true);
  });

  it("treats a whitespace-only title as untitled", () => {
    const label = meetingLabel(meeting({ title: "   " }), "en-US", "Untitled meeting");
    expect(label.startsWith("Untitled meeting — ")).toBe(true);
  });
});
