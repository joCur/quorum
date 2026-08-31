import * as React from "react";
import {
  CircleCheck,
  LoaderCircle,
  Mic,
  MicOff,
  MonitorOff,
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
import { CaptureModeSwitch } from "@/components/recording/capture-mode-switch";
import { ConnectionBanner } from "@/components/recording/connection-banner";
import { ConsentCard } from "@/components/recording/consent-card";
import { HoldToStopButton } from "@/components/recording/hold-to-stop-button";
import { LevelMeter } from "@/components/recording/level-meter";
import { RecordingIndicator } from "@/components/recording/recording-indicator";
import { SyncStatus } from "@/components/recording/sync-status";
import { isRecordingFinalizedDespite, limitMessageKey } from "@/features/limits/messages";
import {
  rememberCaptureMode,
  readRememberedCaptureMode,
  type CaptureMode,
} from "@/features/recording/capture-mode";
import { displayCaptureSupport } from "@/features/recording/display-capture";
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
  const [mode, setMode] = React.useState<CaptureMode>(() => readRememberedCaptureMode());
  // Read once: whether this browser has screen capture at all does not change while the screen is
  // open, and calling it per render would be a permission-adjacent probe on every keystroke.
  const [displaySupport] = React.useState(() => displayCaptureSupport());
  const displayUnavailable = mode === "online" && displaySupport === "unsupported";

  const chooseMode = (next: CaptureMode) => {
    setMode(next);
    rememberCaptureMode(next);
  };

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

  // Whether a recording has been on screen during *this* visit.
  //
  // The session outlives the screen, so "the phase is terminal" answers two different questions
  // with the same value: a recording that just ended here, and a finished one left over from an
  // earlier visit. They need opposite views. The flag is set from the live phases, which are
  // rendered before any terminal phase can follow them, so by the time `finalized` arrives it is
  // already true — while a screen opened on a stale finished session never sets it and shows the
  // start stage, which is what `reset()` is about to make true anyway.
  // Adjusted during render rather than in an effect: the very next render must already see it, and
  // an effect would let one frame of the wrong view through — which is the whole bug.
  const [recordedHere, setRecordedHere] = React.useState(false);
  if (!recordedHere && (live || state.phase === "finalizing")) setRecordedHere(true);

  /**
   * The closing view: the recording is over and the screen is on its way out.
   *
   * `finalized` is a terminal phase, not a resting one. Falling back to the start stage between
   * the server's confirmation and the navigation that follows it flashed the consent card and the
   * empty title field for the length of the settle delay — a finished recording appearing to
   * offer a new one. The closing view holds the final time until the navigation completes.
   */
  const closing = recordedHere && (state.phase === "finalizing" || state.phase === "finalized");
  const onStartStage = !live && !closing;

  // The template travels as an explicit id rather than as "send nothing", the prefilled default
  // included: what the screen showed when the recording started is what the summary is made with.
  const beginRecording = () =>
    void start(
      title.trim() === "" ? null : title.trim(),
      templateId === "" ? null : templateId,
      inputs.deviceId,
      mode,
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
            <h1 className="text-display-md">{t("recording.title")}</h1>

            {/* The kind of meeting comes before its title: it decides what will be listened to,
                and everything below it reads differently once it is settled. */}
            <CaptureModeSwitch mode={mode} support={displaySupport} onChoose={chooseMode} />

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
            <ConsentCard mode={mode} />

            {/* The label is a full sentence and must never be clipped: the button grows to hold
                it rather than the words being cut to fit the control.

                Disabled only where the browser genuinely cannot do what the mode says — and never
                on its own: the note directly above states the reason, so the control is dead in
                the same place the explanation is, not somewhere the user has to guess. */}
            <Button
              variant="honey"
              size="lg"
              disabled={busy || displayUnavailable}
              onClick={beginRecording}
              className="h-auto min-h-[52px] whitespace-normal py-3.5 text-center text-[15px] font-extrabold leading-snug"
            >
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Mic aria-hidden="true" />
              )}
              {busy
                ? t("recording.starting")
                : mode === "online"
                  ? t("consent.confirmOnline")
                  : t("consent.confirm")}
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

            {/* The one condition that stops an online recording without ending it. It stands here
                for as long as it holds, because the user has a decision to make: share again and
                carry on, or stop and keep what is already safe. */}
            {state.displayEnded && live ? (
              <p
                role="status"
                data-testid="display-ended-notice"
                className="flex max-w-sm items-center gap-2 text-center text-sm text-warning"
              >
                <MonitorOff className="size-4 shrink-0" aria-hidden="true" />
                {t("recording.displayEnded")}
              </p>
            ) : null}

            <SyncStatus status={state.status} />

            {/* A limit parks the user here with an explanation instead of navigating on, and
                "Finishing…" under a panel that is going nowhere would be a lie. */}
            {closing && state.limit === null ? (
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
              <Button size="lg" onClick={() => void resume()}>
                <Play aria-hidden="true" />
                {/* Resuming an online recording whose share ended reopens the browser's share
                    dialog, so the button says that rather than surprising the user with it. */}
                {state.displayEnded ? t("recording.resumeShare") : t("recording.resume")}
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
