import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/**
 * The breathing dot — the honest "you are on the record" signal.
 *
 * Two motions are deliberately kept apart, on two nested elements, so they
 * neither fight over the same `transform` nor multiply into a strobe:
 *
 * - the inner dot carries the steady base pulse from the shared animation
 *   utility — a calm heartbeat that never changes its rhythm;
 * - the outer wrapper scales gently with the smoothed microphone level, eased
 *   over the default duration so it glides between updates instead of snapping
 *   to each new value.
 *
 * The level is envelope-followed and published at ~10 Hz upstream, and it is the
 * same signal the level meter renders, so dot and meter always move together.
 * With reduced motion both the pulse and the scaling are dropped: the dot is
 * solid and steady, and the state is carried by the label.
 */
export function RecordingIndicator({
  active,
  level,
  className,
}: {
  active: boolean;
  /** Smoothed input level, 0..1. */
  level: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();

  // A gentle ±10% around the resting size, as the component spec asks for.
  const scale = 1 + Math.min(Math.max(level, 0), 1) * 0.1;
  const modulated = active && !reducedMotion;

  return (
    <span
      role="status"
      aria-live="assertive"
      className={cn("inline-flex items-center gap-2", className)}
    >
      <span
        aria-hidden="true"
        style={modulated ? { transform: `scale(${scale.toFixed(3)})` } : undefined}
        className="inline-flex transition-transform ease-enter will-change-transform"
      >
        <span
          className={cn(
            "block size-2.5 rounded-full",
            active
              ? "animate-recording-pulse bg-recording"
              : "border-2 border-recording bg-transparent",
          )}
        />
      </span>
      <span
        className={cn(
          "font-mono text-xs font-medium tracking-widest",
          active ? "text-recording" : "text-muted-foreground",
        )}
      >
        {active ? t("recording.indicator.recording") : t("recording.indicator.paused")}
      </span>
    </span>
  );
}
