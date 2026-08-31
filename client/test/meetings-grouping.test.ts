import { describe, expect, it } from "vitest";
import type { Meeting } from "@quorum/shared";
import {
  WEEK_HORIZON_WEEKS,
  groupId,
  groupMeetingsByDay,
  groupOf,
} from "@/features/meetings/grouping";

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

describe("meeting grouping", () => {
  const now = at(2026, 8, 31, 14, 30); // A Monday afternoon.

  describe("the named buckets", () => {
    it("puts the same calendar day under today, however long ago it was", () => {
      // Half past midnight this morning is fourteen hours back but still today, and half an hour
      // ago is today too — elapsed time is not what the label claims.
      expect(groupOf(at(2026, 8, 31, 0, 30).toISOString(), now)).toEqual({ kind: "today" });
      expect(groupOf(at(2026, 8, 31, 14, 0).toISOString(), now)).toEqual({ kind: "today" });
    });

    it("does not call last night yesterday just because it was hours ago", () => {
      // 23:30 last night is fifteen hours back; 00:30 this morning is fourteen. An elapsed-hours
      // rule would separate them by a hair, and it is the calendar day that decides.
      expect(groupOf(at(2026, 8, 30, 23, 30).toISOString(), now)).toEqual({ kind: "yesterday" });
      expect(groupOf(at(2026, 8, 30, 0, 5).toISOString(), now)).toEqual({ kind: "yesterday" });
    });

    it("holds the six days before yesterday in this week", () => {
      expect(groupOf(at(2026, 8, 29).toISOString(), now)).toEqual({ kind: "thisWeek" });
      // Six days back — the last day still inside the rolling window, even though the
      // Monday-start calendar week would already have called it last week.
      expect(groupOf(at(2026, 8, 25).toISOString(), now)).toEqual({ kind: "thisWeek" });
    });

    it("reads a timestamp from the future as today rather than inventing a bucket", () => {
      // Clock skew between the recording device and this browser must not produce a heading no
      // translation exists for.
      expect(groupOf(at(2026, 9, 2).toISOString(), now)).toEqual({ kind: "today" });
    });
  });

  describe("the dated buckets", () => {
    it("opens a Monday-to-Sunday week where the rolling window ends", () => {
      // Seven days back. Weeks run Monday to Sunday in every language — a product decision, not
      // one derived from the locale.
      const group = groupOf(at(2026, 8, 24).toISOString(), now);
      expect(group.kind).toBe("week");
      if (group.kind !== "week") throw new Error("expected a week");
      expect(group.start).toEqual(at(2026, 8, 24, 0, 0));
      expect(group.end).toEqual(at(2026, 8, 30, 0, 0));
    });

    it("gives a Sunday the week that started on the Monday before it", () => {
      // The off-by-one a naive `getDay()` produces: Sunday is 0, which would open a new week on
      // the day the old one ends.
      const group = groupOf(at(2026, 8, 16).toISOString(), now); // A Sunday.
      if (group.kind !== "week") throw new Error("expected a week");
      expect(group.start).toEqual(at(2026, 8, 10, 0, 0));
      expect(group.end).toEqual(at(2026, 8, 16, 0, 0));
    });

    it("keeps weekly headings up to the horizon and months beyond it", () => {
      // The horizon is eight weeks back from the Monday that opens this week: 31 August minus 56
      // days is 6 July, so that week still gets its own heading and the day before it does not.
      expect(WEEK_HORIZON_WEEKS).toBe(8);
      expect(groupOf(at(2026, 7, 6).toISOString(), now).kind).toBe("week");

      const older = groupOf(at(2026, 7, 5).toISOString(), now); // The Sunday just outside.
      expect(older.kind).toBe("month");
      if (older.kind !== "month") throw new Error("expected a month");
      // Filed by the month it happened in, not by the month its week started in.
      expect(older.start).toEqual(at(2026, 7, 1, 0, 0));
    });

    it("files anything far back by its calendar month", () => {
      expect(groupOf(at(2026, 3, 17).toISOString(), now)).toEqual({
        kind: "month",
        start: at(2026, 3, 1, 0, 0),
      });
    });

    it("keeps a meeting whose date it cannot read", () => {
      // A meeting that exists has to stay reachable and deletable even with a broken timestamp,
      // so it is filed with the oldest rather than dropped.
      expect(groupOf("not a date", now).kind).toBe("month");
    });
  });

  describe("bucket identity", () => {
    it("gives each week and month a stable, distinct id", () => {
      // Monday and Thursday of the same week — one heading, one id.
      const week = groupId(groupOf(at(2026, 8, 17).toISOString(), now));
      const sameWeek = groupId(groupOf(at(2026, 8, 20).toISOString(), now));
      const otherWeek = groupId(groupOf(at(2026, 8, 10).toISOString(), now));
      expect(week).toBe(sameWeek);
      expect(week).not.toBe(otherWeek);
    });

    it("pads the id so ids sort the way the dates do", () => {
      // A `2026-3-1` style id sorts after `2026-12-01` as text, which is the kind of thing that
      // only surfaces once there is a year of data.
      expect(groupId(groupOf(at(2026, 3, 17).toISOString(), now))).toBe("month:2026-03");
      expect(groupId(groupOf(at(2026, 8, 24).toISOString(), now))).toBe("week:2026-08-24");
    });
  });

  describe("assembling the list", () => {
    it("returns the buckets newest first and leaves the empty ones out", () => {
      const groups = groupMeetingsByDay(
        [
          meeting(at(2026, 3, 17), "march"),
          meeting(at(2026, 8, 26), "rolling"),
          meeting(at(2026, 8, 31), "today"),
          meeting(at(2026, 8, 17), "week"),
        ],
        now,
      );
      expect(groups.map((bucket) => bucket.id)).toEqual([
        "today",
        "thisWeek",
        "week:2026-08-17",
        "month:2026-03",
      ]);
    });

    it("orders the dated buckets itself rather than trusting the order it was handed", () => {
      const groups = groupMeetingsByDay(
        [meeting(at(2026, 3, 17), "old"), meeting(at(2026, 8, 17), "recent")],
        now,
      );
      expect(groups.map((bucket) => bucket.id)).toEqual(["week:2026-08-17", "month:2026-03"]);
    });

    it("leaves the newest week bucket holding only what the rolling window did not take", () => {
      // Deliberate: on a Monday the rolling window covers last Tuesday through Sunday, so the
      // week bucket beneath it keeps its own Monday alone. The heading names the week; the rows
      // under it are the ones not already shown above.
      const groups = groupMeetingsByDay(
        [meeting(at(2026, 8, 26), "inWindow"), meeting(at(2026, 8, 24), "leftOver")],
        now,
      );
      expect(groups.map((bucket) => bucket.id)).toEqual(["thisWeek", "week:2026-08-24"]);
      expect(groups[1]?.meetings.map((entry) => entry.id)).toEqual(["leftOver"]);
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

  describe("across a year boundary", () => {
    const january = at(2026, 1, 8, 10, 0); // A Thursday.

    it("gives a week that straddles New Year one bucket, opened by its Monday", () => {
      const group = groupOf(at(2025, 12, 30).toISOString(), january);
      if (group.kind !== "week") throw new Error("expected a week");
      expect(group.start).toEqual(at(2025, 12, 29, 0, 0));
      expect(group.end).toEqual(at(2026, 1, 4, 0, 0));
      expect(groupId(group)).toBe("week:2025-12-29");
    });

    it("counts the horizon backwards across the year change", () => {
      // Eight weeks before the week of 5 January 2026 is the week of 10 November 2025.
      expect(groupOf(at(2025, 11, 12).toISOString(), january).kind).toBe("week");
      expect(groupOf(at(2025, 11, 9).toISOString(), january).kind).toBe("month");
    });
  });
});
