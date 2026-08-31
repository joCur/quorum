import { MonitorSpeaker, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CAPTURE_MODES, type CaptureMode } from "@/features/recording/capture-mode";
import type { DisplayCaptureSupport } from "@/features/recording/display-capture";
import { cn } from "@/lib/utils";

const ICONS: Record<CaptureMode, typeof Users> = {
  "in-person": Users,
  online: MonitorSpeaker,
};

/**
 * The one choice the start stage adds: who is in the room, and who is in the call.
 *
 * A pill switcher rather than a second screen or a set of checkboxes — it is the same pattern the
 * meeting detail uses to put two views under one control, and it keeps the start stage as calm as
 * it was: one row, two words, a default that is already right for most recordings.
 *
 * The note under it is not decoration. In person, it says what will be heard. Online, it states
 * the promise the mode lives or dies by — the share dialog is the price the browser charges for
 * the sound, and Quorum keeps nothing else from it. On a browser that cannot capture a display at
 * all the note says so instead, before the button is pressed rather than after.
 */
export function CaptureModeSwitch({
  mode,
  support,
  onChoose,
}: {
  mode: CaptureMode;
  support: DisplayCaptureSupport;
  onChoose: (mode: CaptureMode) => void;
}) {
  const { t } = useTranslation();
  const unavailable = mode === "online" && support === "unsupported";

  return (
    <div className="flex flex-col gap-2">
      <span id="capture-mode-label" className="text-sm font-medium text-foreground">
        {t("recording.mode.label")}
      </span>

      <div
        role="radiogroup"
        aria-labelledby="capture-mode-label"
        data-testid="capture-mode-switch"
        className="flex gap-0.5 rounded-pill border border-border bg-card p-[3px]"
      >
        {CAPTURE_MODES.map((option) => {
          const Icon = ICONS[option];
          const selected = mode === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`capture-mode-${option}`}
              onClick={() => onChoose(option)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-pill px-[18px] py-2.5 text-[13.5px] font-bold leading-tight transition-colors duration-micro ease-enter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {t(`recording.mode.${option}.label` as "recording.mode.online.label")}
            </button>
          );
        })}
      </div>

      <p
        data-testid="capture-mode-note"
        className={cn(
          "text-pretty text-[13px] leading-relaxed",
          unavailable ? "text-warning" : "text-muted-foreground",
        )}
      >
        {unavailable
          ? t("recording.mode.online.unsupported")
          : t(`recording.mode.${mode}.note` as "recording.mode.online.note")}
      </p>
    </div>
  );
}
