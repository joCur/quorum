import type { Meeting } from "@quorum/shared";

/**
 * Day buckets for the meeting list.
 *
 * The list is read as a diary rather than a table, so the rows are gathered under the day they
 * happened on instead of carrying a full date each.
 */
export const DAY_GROUPS = ["today", "yesterday", "thisWeek", "earlier"] as const;
export type DayGroup = (typeof DAY_GROUPS)[number];

export interface MeetingDayGroup {
  group: DayGroup;
  meetings: Meeting[];
}

/**
 * Which day bucket a moment falls into, relative to `now`.
 *
 * Boundary logic, and why it is this and not something else:
 *
 * - Everything is measured in **local calendar days**, not in elapsed hours and not in UTC. A
 *   meeting recorded at 23:30 belongs to that evening for the person who recorded it; comparing
 *   UTC days would move it to "yesterday" for anyone west of Greenwich, and comparing elapsed
 *   hours would call a 25-hour-old meeting "yesterday" while a 23-hour-old one recorded before
 *   midnight would also be "yesterday" — two different days under one label.
 * - `today` is day difference 0, `yesterday` is 1.
 * - `thisWeek` is a **rolling window of the six days before yesterday** (difference 2…6), not the
 *   current calendar week. Two reasons. A calendar week needs a first weekday, which differs by
 *   locale (Monday in de-DE, Sunday in en-US) and would put the same meeting in different groups
 *   for two people looking at the same data; and on a Monday morning a calendar week would leave
 *   the whole previous week — the meetings still most likely to be wanted — under "Earlier". The
 *   rolling window also keeps the row's weekday label unambiguous: at most six days back, no
 *   weekday name can occur twice in the group.
 * - Anything older is `earlier`.
 * - A timestamp in the future (clock skew between the recording device and this browser) is read
 *   as `today` rather than being given a bucket of its own.
 */
export function dayGroupOf(isoDate: string, now: Date = new Date()): DayGroup {
  const date = new Date(isoDate);
  // An unreadable date has no day; it is sorted with the oldest rather than dropped, because a
  // meeting that exists must stay reachable even when its timestamp is not.
  if (Number.isNaN(date.getTime())) return "earlier";

  const days = calendarDaysBetween(date, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 6) return "thisWeek";
  return "earlier";
}

/**
 * The list split into its day buckets, in order, with empty buckets left out.
 *
 * The incoming order inside a bucket is preserved: the server already sorts the list, and
 * re-sorting here would give the screen a second opinion on an answer it does not own.
 */
export function groupMeetingsByDay(
  meetings: readonly Meeting[],
  now: Date = new Date(),
): MeetingDayGroup[] {
  const buckets = new Map<DayGroup, Meeting[]>();
  for (const meeting of meetings) {
    const group = dayGroupOf(meeting.createdAt, now);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(meeting);
    else buckets.set(group, [meeting]);
  }
  return DAY_GROUPS.filter((group) => buckets.has(group)).map((group) => ({
    group,
    meetings: buckets.get(group) ?? [],
  }));
}

/** Whole local calendar days from `date` to `now`; negative when `date` is in the future. */
function calendarDaysBetween(date: Date, now: Date): number {
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const MS_PER_DAY = 86_400_000;
  // Rounded rather than floored: the two arguments are both local midnights, so the difference
  // is a whole number of days except across a DST change, which shifts it by an hour.
  return Math.round((startOfDay(now) - startOfDay(date)) / MS_PER_DAY);
}
