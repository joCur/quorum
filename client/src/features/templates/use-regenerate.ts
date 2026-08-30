import * as React from "react";
import { useAuth } from "@/features/auth/auth-provider";
import { MeetingApiError } from "@/features/meetings/api";
import { POLL_INTERVAL_MS } from "@/features/meetings/use-meetings";
import { regenerateSummary } from "@/features/templates/api";

/** How long the screen keeps asking for the replacement before it stops on its own. */
const MAX_POLLS = 150;

export interface RegenerationState {
  /** True from the moment the request is accepted until a different summary has arrived. */
  pending: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  start: (templateId: string) => void;
  dismissError: () => void;
}

/**
 * Asking for a summary again, and waiting for it to arrive.
 *
 * WHY THIS POLLS ITSELF: the meeting detail refreshes on a timer only while the pipeline reports
 * work in progress, and a meeting that already has a summary reports `ready` until the worker
 * picks the new job up and writes its row. Between the accepted request and that moment nothing
 * would ask again, so this hook drives the refresh for exactly as long as it is waiting.
 *
 * The wait ends when the visible summary is no longer the one that was on screen when the request
 * was made. Nothing is removed in the meantime — the previous summary stays readable until its
 * replacement exists (COMPONENTS.md §11).
 */
export function useSummaryRegeneration(
  meetingId: string,
  /** Id of the summary currently on screen, or null when there is none. */
  currentSummaryId: string | null,
  reload: () => void,
): RegenerationState {
  const { accessToken } = useAuth();
  const [awaitedFrom, setAwaitedFrom] = React.useState<{ summaryId: string | null } | null>(null);
  const [error, setError] = React.useState<MeetingApiError | null>(null);

  // The reload callback is re-created on every render of the detail screen; keeping it in a ref
  // stops the polling effect from tearing down and restarting each time. It is written in an
  // effect rather than during render, because a render may be discarded and never committed.
  const reloadRef = React.useRef(reload);
  React.useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  const pending = awaitedFrom !== null && awaitedFrom.summaryId === currentSummaryId;

  React.useEffect(() => {
    // Nothing to wait for: either no request was made, or the replacement has arrived — which is
    // read off `pending` rather than recorded, so there is no second copy of the same fact to
    // clear and no state update on the way out of the wait.
    if (!pending) return;

    // Bounded on purpose: a job that dies without ever writing a row would otherwise leave the
    // screen polling forever. When the budget runs out the pipeline stepper and the failure panel
    // are the honest readout, and the user can ask again.
    let remaining = MAX_POLLS;
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        setAwaitedFrom(null);
        return;
      }
      reloadRef.current();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const start = React.useCallback(
    (templateId: string): void => {
      if (!accessToken) return;
      setError(null);
      setAwaitedFrom({ summaryId: currentSummaryId });
      void regenerateSummary(meetingId, templateId, { accessToken })
        .then(() => reloadRef.current())
        .catch((failure: unknown) => {
          setAwaitedFrom(null);
          setError(
            failure instanceof MeetingApiError
              ? failure
              : new MeetingApiError(0, "network", "The request could not be sent."),
          );
        });
    },
    [accessToken, currentSummaryId, meetingId],
  );

  return {
    pending,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    start,
    dismissError: () => setError(null),
  };
}
