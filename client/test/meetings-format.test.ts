import { describe, expect, it } from "vitest";
import type { Meeting } from "@quorum/shared";
import {
  formatGroupRange,
  formatMeetingDate,
  formatMeetingDuration,
  formatMeetingTime,
  meetingLabel,
} from "@/features/meetings/format";

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

  it("says only the time under today and yesterday", () => {
    // The heading already carries the day, so repeating the date in every row would be noise.
    const iso = new Date(2026, 7, 31, 14, 5).toISOString();
    for (const group of ["today", "yesterday"] as const) {
      const text = formatMeetingTime(iso, "en-US", group);
      expect(text).toMatch(/^2:05\s?PM$/i);
    }
  });

  it("names the weekday under any heading that means one week", () => {
    // Seven days hold each weekday once, so the name identifies the day on its own — under the
    // rolling "This week" and under a dated week range alike.
    const monday = new Date(2026, 7, 31, 16, 0).toISOString();
    for (const kind of ["thisWeek", "week"] as const) {
      expect(formatMeetingTime(monday, "en-US", kind)).toContain("Mon");
      expect(formatMeetingTime(monday, "de-DE", kind)).toContain("Mo");
    }
  });

  it("falls back to the full date once the heading stops naming a week", () => {
    const iso = "2026-08-29T10:00:00.000Z";
    expect(formatMeetingTime(iso, "en-US", "month")).toBe(formatMeetingDate(iso, "en-US"));
  });

  it("survives an unreadable timestamp in every group", () => {
    expect(formatMeetingTime("not a date", "en-US", "today")).toBe("");
    expect(formatMeetingTime("not a date", "en-US", "thisWeek")).toBe("");
    expect(formatMeetingTime("not a date", "en-US", "month")).toBe("");
  });
});

describe("dated group headings", () => {
  const now = new Date(2026, 7, 31); // 31 August 2026.
  const week = (start: Date, end: Date) => ({ kind: "week" as const, start, end });
  /**
   * `Intl` sets a range with thin spaces around the en dash. Asserting on the exact code points
   * would make these tests a test of the ICU data rather than of our formatting choices, so the
   * whitespace is normalized and the words and numbers are what is checked.
   */
  const label = (value: string): string => value.replace(/\s+/gu, " ");

  it("writes a week as a range in the locale's own shape", () => {
    // en-US collapses the shared month, de-DE collapses it the other way round and keeps its
    // ordinal dots. Assembling either from a template of ours is how a translation ends up
    // reading like a machine wrote it.
    const range = week(new Date(2026, 7, 24), new Date(2026, 7, 30));
    expect(label(formatGroupRange(range, "en-US", now))).toBe("Aug 24 – 30");
    expect(label(formatGroupRange(range, "de-DE", now))).toBe("24.–30. Aug.");
  });

  it("names both months when a week crosses one", () => {
    const range = week(new Date(2026, 6, 27), new Date(2026, 7, 2));
    expect(label(formatGroupRange(range, "en-US", now))).toBe("Jul 27 – Aug 2");
    expect(formatGroupRange(range, "de-DE", now)).toContain("Juli");
  });

  it("leaves the year off a week inside the current year", () => {
    // The reader is already in 2026; repeating it on every heading is noise on the headings read
    // most often.
    expect(
      formatGroupRange(week(new Date(2026, 7, 24), new Date(2026, 7, 30)), "en-US", now),
    ).not.toContain("2026");
  });

  it("adds the year once a week falls outside the current one", () => {
    const lastYear = week(new Date(2025, 10, 10), new Date(2025, 10, 16));
    expect(formatGroupRange(lastYear, "en-US", now)).toContain("2025");
  });

  it("carries both years through a week that straddles New Year", () => {
    // The case that a single appended year would get wrong: the two ends are in different years,
    // so each needs its own.
    const straddle = week(new Date(2025, 11, 29), new Date(2026, 0, 4));
    const english = formatGroupRange(straddle, "en-US", new Date(2026, 0, 8));
    expect(english).toContain("2025");
    expect(english).toContain("2026");
    expect(english).toMatch(/Dec.*Jan/);
  });

  it("keeps the year on a week that straddles New Year even seen from within that year", () => {
    // Viewed on 8 January 2026 the end of the week is in the current year, but the start is not,
    // so the heading would be a lie without the year on it.
    const straddle = week(new Date(2025, 11, 29), new Date(2026, 0, 4));
    expect(formatGroupRange(straddle, "de-DE", new Date(2026, 0, 8))).toContain("2025");
  });

  it("always names the year on a month heading", () => {
    // Months only appear beyond the week horizon, deep enough into the archive that a bare
    // "June" invites the reader to assume the wrong one.
    const month = { kind: "month" as const, start: new Date(2026, 5, 1) };
    expect(formatGroupRange(month, "en-US", now)).toBe("June 2026");
    expect(formatGroupRange(month, "de-DE", now)).toBe("Juni 2026");
  });
});

describe("meeting duration and labels", () => {
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
