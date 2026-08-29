import type { Meeting, MeetingStatus } from "@quorum/shared";

/** Statuses that mean the backend is still working on the meeting. */
const IN_PROGRESS: ReadonlySet<MeetingStatus> = new Set([
  "recording",
  "queued",
  "transcribing",
  "summarizing",
]);

export function isInProgress(status: MeetingStatus): boolean {
  return IN_PROGRESS.has(status);
}

/**
 * Whether the list is worth refreshing on a timer.
 *
 * Polling stops as soon as nothing is moving. A list of finished meetings changes only when the
 * user does something, and a request every few seconds to be told nothing happened is exactly
 * the kind of busywork the resting-state rule rules out (STATES.md §9) — here in network traffic
 * rather than in pixels.
 */
export function hasWorkInProgress(meetings: readonly Meeting[]): boolean {
  return meetings.some((meeting) => isInProgress(meeting.status));
}
