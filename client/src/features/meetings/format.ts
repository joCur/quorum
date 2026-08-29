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
