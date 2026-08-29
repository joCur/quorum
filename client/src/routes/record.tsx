import * as React from "react";
import { MicOff, Pause, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConnectionBanner } from "@/components/recording/connection-banner";
import { ConsentNotice } from "@/components/recording/consent-notice";
import { LevelMeter } from "@/components/recording/level-meter";
import { RecordButton } from "@/components/recording/record-button";
import { RecordingIndicator } from "@/components/recording/recording-indicator";
import { SyncStatus } from "@/components/recording/sync-status";
import { useRecording } from "@/features/recording/use-recording";
import { formatDuration } from "@/lib/duration";

/**
 * Recording screen — full-screen and distraction-free on every size.
 *
 * The order of events is fixed: consent notice, then the microphone permission,
 * then capture. Nothing here waits on the network; the sync line and the banner
 * report what the server has actually confirmed.
 */
export function RecordRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, start, pause, resume, stop } = useRecording();
  const [consentOpen, setConsentOpen] = React.useState(false);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const [title, setTitle] = React.useState("");

  const active = state.phase === "recording";
  const live = active || state.phase === "paused";

  React.useEffect(() => {
    if (state.phase === "finalized") {
      void navigate("/meetings", { replace: true });
    }
  }, [state.phase, navigate]);

  // Closing the tab mid-recording is survivable, but it should not be silent.
  React.useEffect(() => {
    if (!live) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-background">
      <ConsentNotice
        open={consentOpen}
        onCancel={() => setConsentOpen(false)}
        onConfirm={() => {
          setConsentOpen(false);
          void start(title.trim() === "" ? null : title.trim());
        }}
      />

      <ConnectionBanner status={state.status} storageLow={state.storageLow} />

      <header className="flex items-center justify-between px-4 py-3">
        {live ? (
          <RecordingIndicator active={active} level={state.level} />
        ) : (
          <span className="text-sm font-medium">{t("recording.title")}</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.close")}
          disabled={live}
          onClick={() => void navigate("/meetings")}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <p className="font-mono text-timer tabular-figures" aria-live="off">
          {formatDuration(state.elapsedSeconds)}
        </p>

        <LevelMeter level={state.level} active={active} />

        {state.silent ? (
          <p className="flex items-center gap-2 text-sm text-warning">
            <MicOff className="size-4" aria-hidden="true" />
            {t("recording.noAudio")}
          </p>
        ) : null}

        <SyncStatus status={state.status} />

        {state.error ? (
          <ErrorPanel error={state.error} onRetry={() => setConsentOpen(true)} />
        ) : null}

        {!live && state.phase !== "finalizing" ? (
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Label htmlFor="meeting-title">{t("recording.titleField.label")}</Label>
            <Input
              id="meeting-title"
              value={title}
              placeholder={t("recording.titleField.placeholder")}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
        ) : null}

        {state.wakeLockSupported ? null : (
          <p className="max-w-sm text-center text-xs text-muted-foreground">
            {t("recording.wakeLockUnsupported")}
          </p>
        )}
      </main>

      <footer className="flex flex-col items-center gap-4 px-6 pb-10">
        {confirmStop ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-card p-4 shadow-md">
            <p className="text-sm font-medium">{t("recording.confirmStop.question")}</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmStop(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setConfirmStop(false);
                  stop();
                }}
              >
                {t("recording.confirmStop.confirm")}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-8">
          {active ? (
            <Button variant="secondary" size="lg" onClick={pause}>
              <Pause aria-hidden="true" />
              {t("recording.pause")}
            </Button>
          ) : null}

          <RecordButton
            phase={state.phase}
            onStart={() => setConsentOpen(true)}
            onStop={() => setConfirmStop(true)}
            onResume={resume}
          />
        </div>
      </footer>
    </div>
  );
}

/** Capture failures are rendered straight: what happened, and what to do next. */
function ErrorPanel({
  error,
  onRetry,
}: {
  error: NonNullable<ReturnType<typeof useRecording>["state"]["error"]>;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const messageKey = `recording.error.${error.kind}` as "recording.error.permission-denied";

  return (
    <div
      role="alert"
      className="flex max-w-sm flex-col items-center gap-3 rounded-md bg-destructive/10 p-4 text-center text-sm text-destructive"
    >
      <TriangleAlert className="size-5" aria-hidden="true" />
      <p>{t(messageKey)}</p>
      {error.detail ? <p className="font-mono text-xs opacity-80">{error.detail}</p> : null}
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
