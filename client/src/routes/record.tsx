import * as React from "react";
import {
  CircleCheck,
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  TriangleAlert,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ConnectionBanner } from "@/components/recording/connection-banner";
import { ConsentCard } from "@/components/recording/consent-card";
import { HoldToStopButton } from "@/components/recording/hold-to-stop-button";
import { LevelMeter } from "@/components/recording/level-meter";
import { RecordingIndicator } from "@/components/recording/recording-indicator";
import { SyncStatus } from "@/components/recording/sync-status";
import { isRecordingFinalizedDespite, limitMessageKey } from "@/features/limits/messages";
import { useAudioInputs } from "@/features/recording/use-audio-inputs";
import { useRequiredRecordingSession } from "@/features/recording/recording-context";
import type { RecordingState } from "@/features/recording/use-recording";
import { useTemplates } from "@/features/templates/use-templates";
import { formatDuration } from "@/lib/duration";
import type { LimitErrorCode } from "@quorum/shared";
import { cn } from "@/lib/utils";

/** How long the finalized screen waits for a closing limit before it navigates on. */
const FINALIZE_SETTLE_MS = 600;

/**
 * Recording screen — full-screen and distraction-free on every size.
 *
 * It follows the app theme like every other screen: a light-theme user gets a light recording
 * screen, and nothing here forces its own darkness. What marks capture as a different place is the
 * furniture — a stage with nothing else on it, the REC pill, the level bars and the hold-to-stop
 * ring — not the ground it stands on.
 *
 * The order of events is fixed: the consent notice, then the microphone permission, then capture.
 * The notice is no longer a dialog; it is the card above the start button, and the button states
 * what pressing it confirms. Nothing here waits on the network; the sync line and the banner
 * report what the server has actually confirmed.
 */
export function RecordRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, start, pause, resume, stop, reset } = useRequiredRecordingSession();
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
  const busy = state.phase === "requesting" || state.phase === "finalizing";
  const onStartStage = !live && state.phase !== "finalizing";

  // The template travels as an explicit id rather than as "send nothing", the prefilled default
  // included: what the screen showed when the recording started is what the summary is made with.
  const beginRecording = () =>
    void start(
      title.trim() === "" ? null : title.trim(),
      templateId === "" ? null : templateId,
      inputs.deviceId,
    );

  // The session outlives this screen now, so what is left of the last one — a finished recording,
  // a failed start, a limit — would still be here on the next visit. Opening the screen clears
  // it. A live recording is untouched by this: arriving on it re-attaches to what is running.
  React.useEffect(() => {
    reset();
  }, [reset]);

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

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-background text-foreground">
      <ConnectionBanner status={state.status} storageLow={state.storageLow} />

      <header className="flex items-center justify-between px-5 py-4">
        {live ? (
          <RecordingIndicator active={active} level={state.level} />
        ) : (
          <span className="text-sm font-bold text-muted-foreground">{t("recording.title")}</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.close")}
          onClick={() => void navigate("/meetings")}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-7 overflow-y-auto px-6">
        {onStartStage ? (
          <div className="flex w-full max-w-[420px] flex-col gap-4">
            <h1 className="font-display text-3xl font-extrabold tracking-tight">
              {t("recording.title")}
            </h1>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="meeting-title">{t("recording.titleField.label")}</Label>
              <Input
                id="meeting-title"
                value={title}
                placeholder={t("recording.titleField.placeholder")}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            {offerTemplates ? (
              <div className="flex flex-col gap-1.5">
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
              </div>
            ) : null}

            {offerInputs ? (
              <div className="flex flex-col gap-1.5">
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
              </div>
            ) : null}

            {/* The notice precedes the button in reading order as well as on screen: the
                obligation is read before the control that acts on it. */}
            <ConsentCard />

            {/* The label is a full sentence and must never be clipped: the button grows to hold
                it rather than the words being cut to fit the control. */}
            <Button
              variant="honey"
              size="lg"
              disabled={busy}
              onClick={beginRecording}
              className="h-auto min-h-[52px] whitespace-normal py-3.5 text-center text-[15px] font-extrabold leading-snug"
            >
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Mic aria-hidden="true" />
              )}
              {busy ? t("recording.starting") : t("consent.confirm")}
            </Button>
          </div>
        ) : (
          <>
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

            {/* A recording that changed microphone under the user's feet is a condition they can
                act on — it stands next to the sync line for as long as it holds true. */}
            {state.inputFallback && live ? (
              <p role="status" className="flex items-center gap-2 text-sm text-warning">
                <MicOff className="size-4" aria-hidden="true" />
                {t("recording.inputFallback")}
              </p>
            ) : null}

            <SyncStatus status={state.status} />

            {state.phase === "finalizing" ? (
              <p className="text-sm text-muted-foreground">{t("recording.finishing")}</p>
            ) : null}
          </>
        )}

        {state.limit ? (
          <LimitPanel limit={state.limit} onLeave={() => void navigate("/meetings")} />
        ) : null}

        {state.error && !state.limit ? (
          <ErrorPanel error={state.error} onRetry={beginRecording} />
        ) : null}

        {state.wakeLockSupported ? null : (
          <p className="max-w-sm text-center text-xs text-muted-foreground">
            {t("recording.wakeLockUnsupported")}
          </p>
        )}
      </main>

      <footer className="flex flex-col items-center gap-4 px-6 pb-10">
        {live ? (
          <div className="flex items-center gap-8">
            {active ? (
              <Button variant="secondary" size="lg" onClick={pause}>
                <Pause aria-hidden="true" />
                {t("recording.pause")}
              </Button>
            ) : (
              <Button size="lg" onClick={resume}>
                <Play aria-hidden="true" />
                {t("recording.resume")}
              </Button>
            )}

            <HoldToStopButton active={active} onStop={stop} />
          </div>
        ) : null}
      </footer>
    </div>
  );
}

/** Capture failures are rendered straight: what happened, and what to do next. */
function ErrorPanel({
  error,
  onRetry,
}: {
  error: NonNullable<RecordingState["error"]>;
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
