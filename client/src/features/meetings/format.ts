import type { Meeting } from "@quorum/shared";
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

/** Units the relative form walks down, largest first, with their length in seconds. */
const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** Past this age a relative phrase says less than the date does. */
const RELATIVE_LIMIT_SECONDS = 7 * 86_400;

/**
 * "2 hours ago" — how recent something is, in the reader's language.
 *
 * Freshness is the question a summary's attribution answers, and for something written minutes or
 * hours ago the elapsed time answers it in fewer words than a timestamp does. That stops being
 * true once the thing is old: "4 months ago" is vaguer than the date it happened on, so beyond a
 * week this falls back to the same absolute form the rest of the app uses.
 */
export function formatRelativeTime(isoDate: string, locale: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  const elapsed = (Date.now() - date.getTime()) / 1000;
  if (elapsed >= RELATIVE_LIMIT_SECONDS) return formatMeetingDate(isoDate, locale);

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (elapsed >= seconds) return relative.format(-Math.floor(elapsed / seconds), unit);
  }
  // Younger than a minute is "now", not a count of seconds nobody is watching.
  return relative.format(0, "minute");
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
