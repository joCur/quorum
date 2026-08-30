import * as React from "react";
import { CircleCheck, MicOff, Pause, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ConnectionBanner } from "@/components/recording/connection-banner";
import { ConsentNotice } from "@/components/recording/consent-notice";
import { LevelMeter } from "@/components/recording/level-meter";
import { RecordButton } from "@/components/recording/record-button";
import { RecordingIndicator } from "@/components/recording/recording-indicator";
import { SyncStatus } from "@/components/recording/sync-status";
import { isRecordingFinalizedDespite, limitMessageKey } from "@/features/limits/messages";
import { useAudioInputs } from "@/features/recording/use-audio-inputs";
import { useRecording } from "@/features/recording/use-recording";
import { useTemplates } from "@/features/templates/use-templates";
import { formatDuration } from "@/lib/duration";
import type { LimitErrorCode } from "@quorum/shared";
import { cn } from "@/lib/utils";

/** How long the finalized screen waits for a closing limit before it navigates on. */
const FINALIZE_SETTLE_MS = 600;

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
  const templates = useTemplates();
  const inputs = useAudioInputs();
  // `null` means "not touched yet", which is what keeps the field following the user's default
  // while it is still loading — an explicit choice replaces it and is never overwritten again.
  const [chosenTemplate, setChosenTemplate] = React.useState<string | null>(null);

  const defaultTemplate = templates.templates.find((view) => view.isDefault)?.template.id ?? null;
  const templateId = chosenTemplate ?? defaultTemplate ?? "";
  // One template is no choice. Showing a select with a single option would be a control that
  // cannot do anything — the resting state stays silent until the user has templates of their own.
  const offerTemplates = templates.status === "ready" && templates.templates.length > 1;
  // One microphone is no choice, and an unnamed list is no choice either (see `useAudioInputs`).
  // Both cases leave the capture screen as bare as it was.
  const offerInputs = inputs.inputs.length > 1;

  const active = state.phase === "recording";
  const live = active || state.phase === "paused";

  React.useEffect(() => {
    if (state.phase !== "finalized" || state.limit !== null) return;
    // The server closes the socket right after finalizing, and a hard stop at the maximum length
    // names that limit in the close frame — one tick after the finalized message. The short wait
    // is what keeps the screen from navigating away from a message it is about to receive.
    const handle = window.setTimeout(
      () => void navigate("/meetings", { replace: true }),
      FINALIZE_SETTLE_MS,
    );
    return () => window.clearTimeout(handle);
  }, [state.phase, state.limit, navigate]);

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
          // The template travels as an explicit id rather than as "send nothing", the prefilled
          // default included: what the screen showed when the recording started is what the
          // summary is made with.
          void start(
            title.trim() === "" ? null : title.trim(),
            templateId === "" ? null : templateId,
            inputs.deviceId,
          );
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
        {/* Recorded time, not wall clock: it stands still while the recording is paused. */}
        <p
          data-testid="recording-timer"
          className="font-mono text-timer tabular-figures"
          aria-live="off"
        >
          {formatDuration(state.elapsedSeconds)}
        </p>

        <LevelMeter level={state.level} active={active} />

        {state.silent ? (
          <p className="flex items-center gap-2 text-sm text-warning">
            <MicOff className="size-4" aria-hidden="true" />
            {t("recording.noAudio")}
          </p>
        ) : null}

        {/* A recording that changed microphone under the user's feet is a condition they can act
            on — it stands next to the sync line for as long as it holds true. */}
        {state.inputFallback && live ? (
          <p role="status" className="flex items-center gap-2 text-sm text-warning">
            <MicOff className="size-4" aria-hidden="true" />
            {t("recording.inputFallback")}
          </p>
        ) : null}

        <SyncStatus status={state.status} />

        {state.limit ? (
          <LimitPanel limit={state.limit} onLeave={() => void navigate("/meetings")} />
        ) : null}

        {state.error && !state.limit ? (
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

            {offerTemplates ? (
              <>
                <Label htmlFor="summary-template">{t("recording.templateField.label")}</Label>
                <Select
                  id="summary-template"
                  value={templateId}
                  onChange={(event) => setChosenTemplate(event.target.value)}
                >
                  {templates.templates.map((view) => (
                    <option key={view.template.id} value={view.template.id}>
                      {view.template.name}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}

            {offerInputs ? (
              <>
                <Label htmlFor="input-device">{t("recording.inputField.label")}</Label>
                <Select
                  id="input-device"
                  value={inputs.deviceId ?? ""}
                  onChange={(event) =>
                    inputs.choose(event.target.value === "" ? null : event.target.value)
                  }
                >
                  <option value="">{t("recording.inputField.systemDefault")}</option>
                  {inputs.inputs.map((input) => (
                    <option key={input.deviceId} value={input.deviceId}>
                      {input.label}
                    </option>
                  ))}
                </Select>
                {inputs.forgotten ? (
                  <p className="text-sm text-warning">{t("recording.inputField.forgotten")}</p>
                ) : null}
              </>
            ) : null}
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

/**
 * A limit the server enforced, said plainly.
 *
 * The hard stop at the maximum session length is not a failure and is not styled as one: the
 * recording was finalized by the server and is on its way through the pipeline like any other.
 * The remaining limits refuse something, and those read as refusals — what the limit is, and what
 * the user can do about it, with no invitation to retry something that would be refused again.
 */
function LimitPanel({ limit, onLeave }: { limit: LimitErrorCode; onLeave: () => void }) {
  const { t } = useTranslation();
  const finalized = isRecordingFinalizedDespite(limit);

  return (
    <div
      role="alert"
      className={cn(
        "flex max-w-sm flex-col items-center gap-3 rounded-md p-4 text-center text-sm",
        finalized ? "bg-muted text-foreground" : "bg-destructive/10 text-destructive",
      )}
    >
      {finalized ? (
        <CircleCheck className="size-5 text-success" aria-hidden="true" />
      ) : (
        <TriangleAlert className="size-5" aria-hidden="true" />
      )}
      <p>{t(limitMessageKey(limit))}</p>
      <Button variant="secondary" size="sm" onClick={onLeave}>
        {t("recording.limit.toMeetings")}
      </Button>
    </div>
  );
}
