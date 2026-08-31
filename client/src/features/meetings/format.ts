import type { Meeting } from "@quorum/shared";
import type { MeetingGroup, MeetingGroupKind } from "@/features/meetings/grouping";
import { formatDuration } from "@/lib/duration";

/**
 * How a meeting is written out in the list and in confirmations.
 *
 * The locale is passed in rather than read from a module-level singleton, so switching the UI
 * language re-renders dates in the new language instead of keeping the ones formatted first.
 */

/** Date and time of the recording, e.g. "Aug 29, 10:00 AM". */
export function formatMeetingDate(isoDate: string, locale: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * When the meeting happened, said as briefly as its group allows.
 *
 * The heading already carries the stretch of time, so the row does not repeat it: under "Today"
 * the time alone is enough, and under a heading that names one week — the rolling "This week" or
 * a dated range — the weekday plus the time is unambiguous, because no weekday occurs twice in
 * seven days. Only a month heading leaves the day open, so a row under one names its date.
 */
export function formatMeetingTime(isoDate: string, locale: string, kind: MeetingGroupKind): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  if (kind === "month") return formatMeetingDate(isoDate, locale);

  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  if (kind !== "thisWeek" && kind !== "week") return time;

  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  return `${weekday} · ${time}`;
}

/**
 * The heading for a dated bucket — a week as its range, a month as its name.
 *
 * Everything here is `Intl`'s work rather than a pattern of ours. A range in en-US comes out as
 * "Aug 25 – 31" and in de-DE as "25.–31. Aug.", including the collapsing of the parts the two
 * ends share; hand-assembling that from a template is exactly how a translation ends up reading
 * like a machine wrote it.
 *
 * **The year appears only when it is not the current one.** A range inside this year does not
 * need it — the reader is already there — and repeating it on every heading is noise on the
 * headings that are read most. Once a bucket falls outside this year the year becomes the thing
 * that identifies it, so it is shown; a week that straddles New Year gets it on both ends
 * ("Dec 29, 2025 – Jan 4, 2026"), which `Intl` handles on its own once the year is asked for.
 *
 * **A month heading always carries its year.** Months only appear beyond the week horizon, deep
 * enough into the archive that "June" alone invites the reader to assume the wrong one.
 */
export function formatGroupRange(
  group: MeetingGroup,
  locale: string,
  now: Date = new Date(),
): string {
  const currentYear = now.getFullYear();

  if (group.kind === "month") {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(group.start);
  }
  if (group.kind !== "week") return "";

  const spansAnotherYear =
    group.start.getFullYear() !== currentYear || group.end.getFullYear() !== currentYear;
  const formatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(spansAnotherYear ? { year: "numeric" as const } : {}),
  });
  // `formatRange` is the part that knows a range is not two dates with a dash between them.
  // Where it is missing, two full dates still say the right thing, just at more length.
  if (typeof formatter.formatRange === "function") {
    return formatter.formatRange(group.start, group.end);
  }
  return `${formatter.format(group.start)} – ${formatter.format(group.end)}`;
}

/** `mm:ss` / `h:mm:ss`, or null while the length is not known yet. */
export function formatMeetingDuration(meeting: Meeting): string | null {
  return meeting.durationSeconds === null ? null : formatDuration(meeting.durationSeconds);
}

/**
 * "Weekly sync — Aug 29" for the delete confirmation, which has to name the meeting the user is
 * about to lose. An untitled meeting is identified by its date alone.
 */
export function meetingLabel(meeting: Meeting, locale: string, untitled: string): string {
  const date = formatMeetingDate(meeting.createdAt, locale);
  const title = meeting.title?.trim();
  if (!title) return `${untitled} — ${date}`;
  return `${title} — ${date}`;
}
