import { describe, expect, it } from "vitest";
import type { Meeting } from "@quorum/shared";
import { dayGroupOf, groupMeetingsByDay } from "@/features/meetings/grouping";

/** Local wall-clock time, which is what the grouping is defined against. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

function meeting(createdAt: Date | string, id = "m"): Meeting {
  return {
    id,
    sessionId: "11111111-0000-4000-8000-000000000002",
    title: "Weekly sync",
    status: "ready",
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    createdAt: typeof createdAt === "string" ? createdAt : createdAt.toISOString(),
    finalizedAt: null,
    durationSeconds: 600,
    language: "en",
    progress: null,
    hasAudio: true,
    failure: null,
  };
}

describe("meeting day grouping", () => {
  const now = at(2026, 8, 31, 14, 30); // A Monday afternoon.

  it("puts the same calendar day under today, however long ago it was", () => {
    // Half past midnight this morning is fourteen hours back but still today, and half an hour
    // ago is today too — elapsed time is not what the label claims.
    expect(dayGroupOf(at(2026, 8, 31, 0, 30).toISOString(), now)).toBe("today");
    expect(dayGroupOf(at(2026, 8, 31, 14, 0).toISOString(), now)).toBe("today");
  });

  it("does not call last night yesterday just because it was hours ago", () => {
    // 23:30 last night is fifteen hours back; 00:30 this morning is fourteen. An elapsed-hours
    // rule would separate them by a hair, and it is the calendar day that decides.
    expect(dayGroupOf(at(2026, 8, 30, 23, 30).toISOString(), now)).toBe("yesterday");
    expect(dayGroupOf(at(2026, 8, 30, 0, 5).toISOString(), now)).toBe("yesterday");
  });

  it("holds the six days before yesterday in this week", () => {
    expect(dayGroupOf(at(2026, 8, 29).toISOString(), now)).toBe("thisWeek");
    // Six days back — the last day still inside the window, even though a Monday-start calendar
    // week would already have called it last week.
    expect(dayGroupOf(at(2026, 8, 25).toISOString(), now)).toBe("thisWeek");
  });

  it("drops everything past the window into earlier", () => {
    expect(dayGroupOf(at(2026, 8, 24, 23, 59).toISOString(), now)).toBe("earlier");
    expect(dayGroupOf(at(2025, 12, 24).toISOString(), now)).toBe("earlier");
  });

  it("reads a timestamp from the future as today rather than inventing a group", () => {
    // Clock skew between the recording device and this browser must not produce a heading no
    // translation exists for.
    expect(dayGroupOf(at(2026, 9, 2).toISOString(), now)).toBe("today");
  });

  it("keeps a meeting whose date it cannot read", () => {
    // A meeting that exists has to stay reachable and deletable even with a broken timestamp.
    expect(dayGroupOf("not a date", now)).toBe("earlier");
  });

  it("returns the buckets in order and leaves the empty ones out", () => {
    const groups = groupMeetingsByDay(
      [
        meeting(at(2026, 8, 26), "week"),
        meeting(at(2026, 8, 31), "today"),
        meeting(at(2020, 1, 1), "old"),
      ],
      now,
    );
    expect(groups.map((group) => group.group)).toEqual(["today", "thisWeek", "earlier"]);
  });

  it("preserves the server's order inside a bucket", () => {
    // The list arrives sorted; re-sorting here would give the screen a second opinion on an
    // answer the server already owns.
    const groups = groupMeetingsByDay(
      [meeting(at(2026, 8, 31, 9), "first"), meeting(at(2026, 8, 31, 16), "second")],
      now,
    );
    expect(groups[0]?.meetings.map((entry) => entry.id)).toEqual(["first", "second"]);
  });
});
