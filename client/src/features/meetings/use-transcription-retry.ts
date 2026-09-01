import * as React from "react";
import { useAuth } from "@/features/auth/auth-provider";
import { MeetingApiError, retryTranscription } from "@/features/meetings/api";

export interface TranscriptionRetryState {
  /** True from the click until the reloaded meeting no longer reports the failure. */
  pending: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  start: () => void;
}

/**
 * Asking for a failed transcription to be run again.
 *
 * WHY IT DOES NOT POLL: unlike a regenerate, an accepted retry changes the meeting's own state —
 * the job row goes back to `queued`, so the meeting stops reporting a failure and starts
 * reporting work in progress. Reloading once is enough; from there the detail screen's own timer
 * takes over, because it refreshes for exactly as long as the pipeline says something is moving.
 *
 * `pending` therefore ends by itself, when the reload comes back with a meeting that is no longer
 * failed and this panel is gone. It is cleared explicitly only on a refusal, where nothing
 * changed and the action has to be offered again.
 */
export function useTranscriptionRetry(
  meetingId: string,
  reload: () => void,
): TranscriptionRetryState {
  const { accessToken } = useAuth();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<MeetingApiError | null>(null);

  // The reload callback is re-created on every render of the detail screen; keeping it in a ref
  // means `start` does not change identity with it.
  const reloadRef = React.useRef(reload);
  React.useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  const start = React.useCallback((): void => {
    if (!accessToken) return;
    setError(null);
    setPending(true);
    void retryTranscription(meetingId, { accessToken })
      .then(() => reloadRef.current())
      .catch((failure: unknown) => {
        setPending(false);
        // Same reason as the loading screens: an expired session is handled once, centrally, and
        // saying "this failed" here would name the wrong problem.
        if (failure instanceof MeetingApiError && failure.isUnauthorized) return;
        setError(
          failure instanceof MeetingApiError
            ? failure
            : new MeetingApiError(0, "network", "The request could not be sent."),
        );
      });
  }, [accessToken, meetingId]);

  return {
    pending,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    start,
  };
}
