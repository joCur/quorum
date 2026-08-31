import { Pause } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/**
 * The REC pill — the honest "you are on the record" signal.
 *
 * Red and the breathing dot belong to live capture and to nothing else, so the pill has exactly
 * two forms: a solid `recording`-red pill with a pulsing dot while audio is being captured, and a
 * neutral outlined PAUSE pill when it is not. Nothing red is on screen while the microphone is not
 * running, which is what makes the red mean something when it is.
 *
 * The pill does not depend on a dark ground to read as "on air": red carries 5.3:1 against its own
 * white text and 4.9:1 against paper, so it keeps full prominence in a light theme as well as in a
 * dark one.
 *
 * Two motions are deliberately kept apart, on two nested elements, so they neither fight over the
 * same `transform` nor multiply into a strobe:
 *
 * - the inner dot carries the steady base pulse from the shared animation utility — a calm
 *   heartbeat that never changes its rhythm;
 * - the outer wrapper scales gently with the smoothed microphone level, eased over the default
 *   duration so it glides between updates instead of snapping to each new value.
 *
 * The level is envelope-followed and published at ~10 Hz upstream, and it is the same signal the
 * level meter renders, so pill and meter always move together. With reduced motion both the pulse
 * and the scaling are dropped: the dot is solid and steady, and the state is carried by the label.
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
      data-testid="recording-indicator"
      data-active={active}
      className={cn(
        "inline-flex items-center gap-2 rounded-pill px-3.5 py-1.5 font-mono text-xs font-bold tracking-widest",
        active
          ? "bg-recording text-recording-foreground"
          : "border border-border bg-card text-muted-foreground",
        className,
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          style={modulated ? { transform: `scale(${scale.toFixed(3)})` } : undefined}
          className="inline-flex transition-transform ease-enter will-change-transform"
        >
          <span className="block size-2.5 animate-recording-pulse rounded-full bg-current" />
        </span>
      ) : (
        <Pause className="size-3.5 fill-current" aria-hidden="true" />
      )}
      {active ? t("recording.indicator.recording") : t("recording.pill.paused")}
    </span>
  );
}
