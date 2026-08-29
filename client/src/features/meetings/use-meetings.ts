import * as React from "react";
import type { Meeting } from "@quorum/shared";
import { useAuth } from "@/features/auth/auth-provider";
import { deleteMeeting, listMeetings, MeetingApiError } from "@/features/meetings/api";
import { hasWorkInProgress } from "@/features/meetings/status";

/** How often the list refreshes while something is still being processed. */
export const POLL_INTERVAL_MS = 5000;
/** Typing pause before a search reaches the server. */
export const SEARCH_DEBOUNCE_MS = 250;

export type ListStatus = "loading" | "ready" | "error";

export interface MeetingsList {
  meetings: Meeting[];
  status: ListStatus;
  /** Machine-readable error code of the last failed load, for the i18n message. */
  errorCode: string | null;
  /** Meeting ids whose deletion the server has not confirmed yet. */
  deleting: ReadonlySet<string>;
  reload: () => void;
  remove: (meetingId: string) => Promise<void>;
}

export function useMeetings(search: string): MeetingsList {
  const { accessToken } = useAuth();
  const [meetings, setMeetings] = React.useState<Meeting[]>([]);
  const [status, setStatus] = React.useState<ListStatus>("loading");
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ReadonlySet<string>>(new Set());
  const [reloadToken, setReloadToken] = React.useState(0);

  const debounced = useDebounced(search, SEARCH_DEBOUNCE_MS);

  React.useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const load = async (): Promise<void> => {
      try {
        const next = await listMeetings({
          accessToken,
          search: debounced || undefined,
          signal: controller.signal,
        });
        if (!active) return;
        setMeetings(next);
        setStatus("ready");
        setErrorCode(null);
        // Reschedule only while something is actually moving, and only from the response we
        // just received — a fixed interval would keep polling a finished list forever.
        if (hasWorkInProgress(next)) timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setStatus("error");
        setErrorCode(error instanceof MeetingApiError ? error.code : "network");
      }
    };

    void load();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, debounced, reloadToken]);

  const reload = React.useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Deletion is a server-side cascade and may take a moment, so the row is marked and left in
   * place — it disappears only once the server has confirmed (STATES.md §6: no optimistic
   * vanish, because a row that comes back would be worse than one that lingers).
   */
  const remove = React.useCallback(
    async (meetingId: string): Promise<void> => {
      if (!accessToken) return;
      setDeleting((current) => new Set(current).add(meetingId));
      try {
        await deleteMeeting(meetingId, { accessToken });
        setMeetings((current) => current.filter((meeting) => meeting.id !== meetingId));
      } finally {
        setDeleting((current) => {
          const next = new Set(current);
          next.delete(meetingId);
          return next;
        });
      }
    },
    [accessToken],
  );

  return { meetings, status, errorCode, deleting, reload, remove };
}

/** Value that only settles after the user has stopped changing it for `delay`. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
