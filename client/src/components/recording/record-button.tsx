import { LoaderCircle, Mic, Play, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { RecordingPhase } from "@/features/recording/use-recording";

/**
 * The app's most important control. Idle it is a circle; recording it morphs
 * into a rounded square — the "it's real now" moment. The label always names the
 * action the press will perform.
 */
export function RecordButton({
  phase,
  onStart,
  onStop,
  onResume,
}: {
  phase: RecordingPhase;
  onStart: () => void;
  onStop: () => void;
  onResume: () => void;
}) {
  const { t } = useTranslation();

  const busy = phase === "requesting" || phase === "finalizing";
  const recording = phase === "recording";
  const paused = phase === "paused";

  const { icon, labelKey, action } = recording
    ? { icon: <Square className="size-8" />, labelKey: "recording.stop", action: onStop }
    : paused
      ? { icon: <Play className="size-8" />, labelKey: "recording.resume", action: onResume }
      : busy
        ? {
            icon: <LoaderCircle className="size-8 animate-spin" />,
            labelKey: phase === "finalizing" ? "recording.finishing" : "recording.starting",
            action: () => undefined,
          }
        : { icon: <Mic className="size-8" />, labelKey: "recording.start", action: onStart };

  const label = t(labelKey as "recording.start");

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={action}
        disabled={busy}
        aria-label={label}
        aria-pressed={recording}
        className={cn(
          "flex size-[72px] items-center justify-center bg-recording text-recording-foreground shadow-sm transition-all duration-large ease-spring hover:shadow-md active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background disabled:opacity-50 md:size-16",
          recording ? "rounded-lg" : "rounded-full",
        )}
      >
        {icon}
      </button>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}
