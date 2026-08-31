import * as React from "react";
import type { Meeting } from "@quorum/shared";
import { isInProgress } from "@/features/meetings/status";

/** How long the "Done" chip stays after a meeting finishes. */
export const JUST_FINISHED_MS = 4000;

/**
 * The meetings that finished while the user was watching.
 *
 * A finished meeting is the resting state of this screen, so it says nothing: a permanent "Ready"
 * chip on every row would be a label repeated until it stops being read (STATES.md §9). The
 * arrival, however, is an event worth one moment of attention — so the chip appears only on the
 * poll that moves a row out of processing, and leaves again on its own.
 *
 * Only a real transition counts. Meetings that are already finished when the list first loads,
 * and rows that arrive finished from a search, never pop: nothing happened, the user simply
 * looked.
 */
export function useJustFinished(meetings: readonly Meeting[]): ReadonlySet<string> {
  const [finished, setFinished] = React.useState<ReadonlySet<string>>(new Set());
  const previous = React.useRef<Map<string, boolean> | null>(null);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  React.useEffect(() => {
    const current = new Map(meetings.map((meeting) => [meeting.id, isInProgress(meeting.status)]));
    const before = previous.current;
    previous.current = current;
    // The first render establishes the baseline; there is no transition to celebrate yet.
    if (before === null) return;

    const arrived = meetings
      .filter((meeting) => meeting.status === "ready" && before.get(meeting.id) === true)
      .map((meeting) => meeting.id);
    if (arrived.length === 0) return;

    setFinished((shown) => new Set([...shown, ...arrived]));
    for (const id of arrived) {
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setFinished((shown) => {
            const next = new Set(shown);
            next.delete(id);
            return next;
          });
        }, JUST_FINISHED_MS),
      );
    }
  }, [meetings]);

  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return finished;
}
