import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { RecordingIndicator } from "@/components/recording/recording-indicator";
import { useRecordingSession } from "@/features/recording/recording-context";
import { formatDuration } from "@/lib/duration";

/**
 * The persistent strip that says a recording is still running, from anywhere in the app.
 *
 * It appears only while a session is live and only away from the recording screen, where the
 * screen itself carries the same signal. It is one button: the whole strip returns to the
 * recording. Recording red is the honest color here — this is live capture, not a notice about
 * it — and the same breathing indicator the recording screen uses carries the pulse and the
 * pause state, so the two never disagree.
 *
 * It sticks to the top of the content column rather than replacing the tab bar: the tab bar is
 * gone on the meeting detail, and a recording in progress is not a thing the user may lose sight
 * of because of which screen they are on.
 */
export function RecordingBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useRecordingSession();

  const phase = session?.state.phase;
  if (!session || (phase !== "recording" && phase !== "paused")) return null;

  return (
    <button
      type="button"
      data-testid="recording-bar"
      onClick={() => void navigate("/record")}
      // Full-bleed inside the content column, which supplies the horizontal padding it undoes.
      className="sticky top-0 z-30 -mx-4 mb-4 flex items-center gap-3 border-b border-recording/30 bg-recording/10 px-4 py-2 text-left backdrop-blur transition-colors duration-micro ease-enter hover:bg-recording/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:-mx-6 md:px-6"
    >
      <RecordingIndicator active={phase === "recording"} level={session.state.level} />
      <span className="font-mono text-sm tabular-figures">
        {formatDuration(session.state.elapsedSeconds)}
      </span>
      <span className="ml-auto flex items-center gap-1 text-sm font-medium text-recording">
        {t("recording.bar.return")}
        <ChevronRight className="size-4" aria-hidden="true" />
      </span>
    </button>
  );
}
