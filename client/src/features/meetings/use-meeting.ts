import * as React from "react";
import type { MeetingDetail } from "@quorum/shared";
import { useAuth } from "@/features/auth/auth-provider";
import { deleteMeeting, fetchMeeting, MeetingApiError } from "@/features/meetings/api";
import { isInProgress } from "@/features/meetings/status";
import { POLL_INTERVAL_MS } from "@/features/meetings/use-meetings";

export type DetailStatus = "loading" | "ready" | "missing" | "error";

export interface MeetingDetailState {
  detail: MeetingDetail | null;
  status: DetailStatus;
  errorCode: string | null;
  deleting: boolean;
  reload: () => void;
  remove: () => Promise<void>;
}

/**
 * Meeting detail, refreshed while the pipeline is still working.
 *
 * `missing` is its own status rather than an error: a meeting that was deleted — in another tab,
 * or by this one — gets the calm "this meeting was deleted" state, not a failure (STATES.md §6).
 */
export function useMeeting(meetingId: string): MeetingDetailState {
  const { accessToken } = useAuth();
  const [detail, setDetail] = React.useState<MeetingDetail | null>(null);
  const [status, setStatus] = React.useState<DetailStatus>("loading");
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const load = async (): Promise<void> => {
      try {
        const next = await fetchMeeting(meetingId, {
          accessToken,
          signal: controller.signal,
        });
        if (!active) return;
        setDetail(next);
        setStatus("ready");
        setErrorCode(null);
        if (isInProgress(next.meeting.status)) {
          timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        // A 401 is not this screen's problem: the shared session-expiry path is already renewing
        // the token or routing into the login flow, so the screen keeps its last honest state
        // instead of blaming the data.
        if (error instanceof MeetingApiError && error.isUnauthorized) return;
        if (error instanceof MeetingApiError && error.isNotFound) {
          setStatus("missing");
          return;
        }
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
  }, [accessToken, meetingId, reloadToken]);

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), []);

  const remove = React.useCallback(async (): Promise<void> => {
    if (!accessToken) return;
    setDeleting(true);
    try {
      await deleteMeeting(meetingId, { accessToken });
    } finally {
      setDeleting(false);
    }
  }, [accessToken, meetingId]);

  return { detail, status, errorCode, deleting, reload, remove };
}
