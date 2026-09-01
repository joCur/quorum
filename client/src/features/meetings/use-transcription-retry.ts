import * as React from "react";
import { useAuth } from "@/features/auth/auth-provider";
import { MeetingApiError, retryTranscription } from "@/features/meetings/api";

export interface TranscriptionRetryState {
  /** True from the click until the meeting reports something other than the failure clicked on. */
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
 * WHY `pending` IS DERIVED RATHER THAN HELD: the obvious version — a flag set on click, cleared
 * on refusal — has a way of never clearing. A retry of a job that fails again quickly (the model
 * is still not installed) can be back in the failed state before the reload that followed the
 * click returns, and then the panel never unmounts and the button stays disabled on "Starting…"
 * with no way back. So the wait is expressed as a question about the data, the way the regenerate
 * hook expresses its own: it lasts while the failure on screen is still the one that was clicked
 * on, and any newer failure — or the absence of one — ends it.
 */
export function useTranscriptionRetry(
  meetingId: string,
  /**
   * When the failure now on screen was recorded. Any other value means a different attempt is
   * being reported, so the wait for the one that was clicked is over.
   */
  failedAt: string | null,
  reload: () => void,
): TranscriptionRetryState {
  const { accessToken } = useAuth();
  const [awaitedFrom, setAwaitedFrom] = React.useState<{ failedAt: string | null } | null>(null);
  const [error, setError] = React.useState<MeetingApiError | null>(null);

  // The reload callback is re-created on every render of the detail screen; keeping it in a ref
  // means `start` does not change identity with it. Written in an effect rather than during
  // render, because a render may be discarded and never committed.
  const reloadRef = React.useRef(reload);
  React.useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  const pending = awaitedFrom !== null && awaitedFrom.failedAt === failedAt;

  const start = React.useCallback((): void => {
    if (!accessToken) return;
    setError(null);
    setAwaitedFrom({ failedAt });
    void retryTranscription(meetingId, { accessToken })
      .then(() => reloadRef.current())
      .catch((failure: unknown) => {
        // A refusal changes nothing, so the action is offered again at once rather than waiting
        // for a state transition that is not coming.
        setAwaitedFrom(null);
        // Same reason as the loading screens: an expired session is handled once, centrally, and
        // saying "this failed" here would name the wrong problem.
        if (failure instanceof MeetingApiError && failure.isUnauthorized) return;
        setError(
          failure instanceof MeetingApiError
            ? failure
            : new MeetingApiError(0, "network", "The request could not be sent."),
        );
      });
  }, [accessToken, failedAt, meetingId]);

  return {
    pending,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    start,
  };
}
