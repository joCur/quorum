import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { asLimitCode, limitMessageKey } from "@/features/limits/messages";
import { useTranscriptionRetry } from "@/features/meetings/use-transcription-retry";

export interface RetryTranscriptionProps {
  meetingId: string;
  /**
   * When the failure on screen was recorded — the mark the wait is measured against, so a job
   * that fails again while the screen is reloading offers the action anew instead of freezing.
   */
  failedAt: string | null;
  /** Refreshes the meeting once the retry has been accepted. */
  onReload: () => void;
}

/**
 * The way out of a failed transcription (STATES.md §5: a standing failure offers the action that
 * ends it, not just an apology).
 *
 * It is rendered only for failures another attempt could actually survive — the caller checks the
 * error code against the shared taxonomy — because a button that is guaranteed to be refused is
 * worse than no button: it invites the user to keep pressing something that cannot work.
 *
 * No confirmation: retrying destroys nothing. The recording is untouched, and a meeting with no
 * transcript has nothing that a second attempt could overwrite.
 */
export function RetryTranscription({ meetingId, failedAt, onReload }: RetryTranscriptionProps) {
  const { t } = useTranslation();
  const retry = useTranscriptionRetry(meetingId, failedAt, onReload);

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={retry.pending}
          onClick={retry.start}
          className="rounded-pill border-border bg-card px-[18px] text-[13px] font-bold"
        >
          {/* Work in progress is said in the label and nowhere else — the same voice the
              regenerate control uses, for the same reason. */}
          {retry.pending ? t("meeting.transcript.retrying") : t("meeting.transcript.retry")}
        </Button>
      </div>
      {retry.errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {retryMessage(t, retry.errorCode) ?? retry.errorMessage}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The refusals a retry can come back with, in the user's language.
 *
 * A limit is the likely one: a transcription costs GPU time, so this route has the same small
 * allowance the regenerate has. Anything unrecognized keeps the server's own message, which still
 * names the problem better than a generic sentence would — and every refusal this endpoint sends
 * is about the request, never a quote from a backend.
 */
function retryMessage(t: TFunction, code: string | null): string | null {
  if (code === "transcription_in_progress") return t("meeting.transcript.alreadyRunning");
  if (code === "transcription_not_failed") return t("meeting.transcript.nothingToRetry");
  if (code === "transcription_not_retryable") return t("meeting.transcript.retryPointless");
  if (code === "queue_unavailable") return t("meeting.transcript.retryUnavailable");
  const limit = asLimitCode(code);
  return limit === null ? null : t(limitMessageKey(limit));
}
