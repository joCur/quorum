import * as React from "react";
import type { MeetingDetail, SegmentCorrectionResponse, SegmentOverlay } from "@quorum/shared";
import { useAuth } from "@/features/auth/auth-provider";
import {
  correctSegment,
  deleteMeeting,
  fetchMeeting,
  MeetingApiError,
  renameMeeting,
  resetSegment,
} from "@/features/meetings/api";
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
  /**
   * Stores a new name for the meeting; an empty title clears it and returns the meeting to
   * unnamed. Rejects when the request fails, so the screen can say so and keep the editor open.
   */
  rename: (title: string) => Promise<void>;
  /**
   * Corrects one transcript segment (ADR-003 §2). Rejects when the request fails, so the segment
   * can say so and keep what was typed.
   */
  correct: (segmentId: string, overlay: SegmentOverlay) => Promise<void>;
  /** Takes a segment's correction back off, which brings the machine's own words back. */
  reset: (segmentId: string) => Promise<void>;
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

  /**
   * The new name is put on the detail already in hand rather than triggering a reload: the
   * server has confirmed it, and re-fetching the whole meeting would replace a transcript and a
   * summary that did not change — visibly, on a screen the user is reading.
   */
  const rename = React.useCallback(
    async (title: string): Promise<void> => {
      if (!accessToken) return;
      const meeting = await renameMeeting(meetingId, title, { accessToken });
      setDetail((current) => (current === null ? current : { ...current, meeting }));
    },
    [accessToken, meetingId],
  );

  /**
   * Puts a confirmed correction onto the detail in hand, for the same reason a rename does: the
   * transcript is what the user is reading, and re-fetching it under them would move the page.
   *
   * The server's answer is what lands, not the typed text — it has already decided whether that
   * counts as a correction at all, and a segment that came back uncorrected has to stop wearing
   * the marker.
   */
  const applyCorrection = React.useCallback(
    (segmentId: string, answer: SegmentCorrectionResponse): void => {
      setDetail((current) => {
        if (current === null || current.transcript === null) return current;
        return {
          ...current,
          transcript: {
            ...current.transcript,
            segments: current.transcript.segments.map((segment) =>
              segment.id === segmentId ? answer.segment : segment,
            ),
          },
        };
      });
    },
    [],
  );

  const correct = React.useCallback(
    async (segmentId: string, overlay: SegmentOverlay): Promise<void> => {
      if (!accessToken) return;
      applyCorrection(
        segmentId,
        await correctSegment(meetingId, segmentId, overlay, { accessToken }),
      );
    },
    [accessToken, applyCorrection, meetingId],
  );

  const reset = React.useCallback(
    async (segmentId: string): Promise<void> => {
      if (!accessToken) return;
      applyCorrection(segmentId, await resetSegment(meetingId, segmentId, { accessToken }));
    },
    [accessToken, applyCorrection, meetingId],
  );

  return { detail, status, errorCode, deleting, reload, remove, rename, correct, reset };
}
