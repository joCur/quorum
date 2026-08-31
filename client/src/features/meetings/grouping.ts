import type { Meeting } from "@quorum/shared";

/**
 * Time buckets for the meeting list.
 *
 * The list is read as a diary rather than a table, so the rows are gathered under the stretch of
 * time they happened in instead of carrying a full date each. The buckets get coarser as they get
 * older, because that is how the value of a meeting decays: the recent ones are looked for by day,
 * the older ones by roughly when.
 */

/** The three named buckets, in the order they appear. Their labels come from i18n. */
export const NAMED_GROUPS = ["today", "yesterday", "thisWeek"] as const;
export type NamedGroup = (typeof NAMED_GROUPS)[number];

/**
 * How far back the list keeps one row per calendar week before falling back to whole months.
 *
 * Eight weeks is two months of weekly headings — enough that a meeting from "the week before
 * last" is still found by its date range, and few enough that the list does not become a stack of
 * headings with one row each. Past that the user is browsing an archive rather than looking for
 * something specific, and a month is the unit they remember it by.
 */
export const WEEK_HORIZON_WEEKS = 8;

export type MeetingGroup =
  | { kind: NamedGroup }
  /** One Monday–Sunday week, labeled by its date range. */
  | { kind: "week"; start: Date; end: Date }
  /** One local calendar month, labeled by name and year. */
  | { kind: "month"; start: Date };

export type MeetingGroupKind = MeetingGroup["kind"];

export interface MeetingGroupBucket {
  group: MeetingGroup;
  /** Stable identity for React keys and for collecting rows — not shown to the user. */
  id: string;
  meetings: Meeting[];
}

/**
 * Which bucket a moment falls into, relative to `now`.
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
 *   current calendar week. On a Monday morning a calendar week would leave the whole previous
 *   week — the meetings still most likely to be wanted — under an older heading. The rolling
 *   window also keeps the row's weekday label unambiguous: at most six days back, no weekday name
 *   can occur twice in the group.
 * - Older than that, up to {@link WEEK_HORIZON_WEEKS}, comes one bucket per **week**, labeled by
 *   its date range ("Aug 25 – 31", "25.–31. Aug.").
 * - Beyond the horizon, one bucket per **local calendar month**.
 * - A timestamp in the future (clock skew between the recording device and this browser) is read
 *   as `today` rather than being given a bucket of its own.
 *
 * **Weeks run Monday to Sunday, in every language.** This is a product decision, not a derived
 * one: the alternative is to take the first weekday from the locale, which would silently put the
 * same meeting under two different headings for two people looking at the same data — a Sunday
 * meeting opening the week for one of them and closing it for the other. One definition keeps a
 * shared list describable between colleagues. A per-user week-start preference is planned as its
 * own piece of work; until it exists, the setting is Monday rather than an accident of the browser
 * language. The headings state the range they cover, so the choice is visible rather than assumed.
 *
 * Note that the named buckets are claimed first, so the newest week bucket may hold only the part
 * of its week that `thisWeek` did not already take. That is deliberate: its heading names the
 * week, and the rows under it are the ones not already shown above.
 */
export function groupOf(isoDate: string, now: Date = new Date()): MeetingGroup {
  const date = new Date(isoDate);
  // An unreadable date has no day. It is filed with the oldest rather than dropped, because a
  // meeting that exists must stay reachable — and deletable — even when its timestamp is not.
  if (Number.isNaN(date.getTime())) return { kind: "month", start: startOfMonth(new Date(0)) };

  const days = calendarDaysBetween(date, now);
  if (days <= 0) return { kind: "today" };
  if (days === 1) return { kind: "yesterday" };
  if (days <= 6) return { kind: "thisWeek" };

  const weekStart = startOfWeek(date);
  const horizon = addDays(startOfWeek(now), -WEEK_HORIZON_WEEKS * 7);
  if (weekStart.getTime() >= horizon.getTime()) {
    return { kind: "week", start: weekStart, end: addDays(weekStart, 6) };
  }
  return { kind: "month", start: startOfMonth(date) };
}

/** Stable identity for a bucket — the map key and the React key, never shown to the user. */
export function groupId(group: MeetingGroup): string {
  if (group.kind === "week") return `week:${isoDay(group.start)}`;
  if (group.kind === "month") return `month:${isoDay(group.start).slice(0, 7)}`;
  return group.kind;
}

/**
 * The list split into its buckets, newest first, with empty buckets left out.
 *
 * The incoming order inside a bucket is preserved: the server already sorts the list, and
 * re-sorting here would give the screen a second opinion on an answer it does not own. The buckets
 * themselves are ordered here rather than taken from the input, so a list that arrives out of
 * order still produces headings that run from recent to old.
 */
export function groupMeetingsByDay(
  meetings: readonly Meeting[],
  now: Date = new Date(),
): MeetingGroupBucket[] {
  const buckets = new Map<string, MeetingGroupBucket>();
  for (const meeting of meetings) {
    const group = groupOf(meeting.createdAt, now);
    const id = groupId(group);
    const existing = buckets.get(id);
    if (existing) existing.meetings.push(meeting);
    else buckets.set(id, { group, id, meetings: [meeting] });
  }

  const all = [...buckets.values()];
  const named = NAMED_GROUPS.map((kind) => all.find((bucket) => bucket.id === kind)).filter(
    (bucket): bucket is MeetingGroupBucket => bucket !== undefined,
  );
  const dated = all
    .filter((bucket) => bucket.group.kind === "week" || bucket.group.kind === "month")
    .sort((left, right) => startOf(right.group).getTime() - startOf(left.group).getTime());

  return [...named, ...dated];
}

function startOf(group: MeetingGroup): Date {
  return group.kind === "week" || group.kind === "month" ? group.start : new Date(0);
}

/** Local midnight of the Monday that opens the week containing `date`. */
function startOfWeek(date: Date): Date {
  // `Date#getDay` counts 0 = Sunday … 6 = Saturday, so Sunday is six days into a Monday week.
  const offset = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Calendar-day arithmetic, which stays correct across a DST change where adding hours would not. */
function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** `YYYY-MM-DD` in local time, for bucket identity only. */
function isoDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
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
