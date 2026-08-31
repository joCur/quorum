import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Bar count and shape come from the v2 recording stage: a symmetric row centred under the timer. */
const BAR_COUNT = 21;
const CENTRE = (BAR_COUNT - 1) / 2;
const MIN_HEIGHT_PX = 4;
const MAX_LIFT_PX = 56;

/**
 * The input-level bars under the timer. They exist for trust: visibly moving bars are proof the
 * microphone is picking up audio, and a flat grey row is proof it is not.
 *
 * Red is live capture and only live capture. While recording, the bars are `recording` red and
 * ride the smoothed input level. The moment capture stops — paused, finalizing, idle — they turn
 * neutral and hold their last position rather than collapsing: frozen bars for a frozen timer,
 * which reads as "held" instead of "broken". Idle, before anything has been captured, they rest
 * flat.
 *
 * The row is a `meter` with a real value, so the level is available to a screen reader too; the
 * bars themselves are decoration of that one honest number.
 */
export function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const { t } = useTranslation();
  const clamped = Math.min(1, Math.max(0, level));
  const percentage = Math.round(clamped * 100);

  // What the bars showed when capture last ran. Freezing is the point: releasing the level to zero
  // on pause would read as a microphone that died rather than one that was deliberately held.
  // The live level is mirrored into a ref so that capturing it costs no render, and it is only
  // promoted to state on the edge where capture stops — which is the one moment it matters.
  const latest = React.useRef(clamped);
  const [frozen, setFrozen] = React.useState(clamped);
  React.useEffect(() => {
    latest.current = clamped;
  }, [clamped]);
  React.useEffect(() => {
    if (!active) setFrozen(latest.current);
  }, [active]);
  const shown = active ? clamped : frozen;

  return (
    <div
      role="meter"
      aria-label={t("recording.levelMeter")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={active ? percentage : 0}
      data-active={active}
      className="flex h-16 items-end justify-center gap-1"
    >
      {Array.from({ length: BAR_COUNT }, (_value, index) => {
        // A soft envelope across the row, so the middle of the meter carries the level and the
        // ends stay quiet — a shape, rather than 21 bars all doing the same thing.
        const envelope = 1 - Math.abs(index - CENTRE) / (CENTRE + 2);
        const height = Math.round(MIN_HEIGHT_PX + shown * envelope * MAX_LIFT_PX);
        return (
          <span
            key={index}
            aria-hidden="true"
            style={{ height: `${height}px` }}
            className={cn(
              "w-[5px] rounded-[3px] transition-[height] duration-micro ease-out",
              active ? "bg-recording" : "bg-border",
            )}
          />
        );
      })}
    </div>
  );
}
