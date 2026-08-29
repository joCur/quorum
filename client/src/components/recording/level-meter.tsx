import { useTranslation } from "react-i18next";

/**
 * Thin input-level bar under the timer. It exists for trust: a visibly moving
 * meter is proof the microphone is picking up audio.
 */
export function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const { t } = useTranslation();
  const percentage = Math.round(Math.min(1, Math.max(0, level)) * 100);

  return (
    <div
      role="meter"
      aria-label={t("recording.levelMeter")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={active ? percentage : 0}
      className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-micro ease-enter"
        style={{ width: `${active ? percentage : 0}%` }}
      />
    </div>
  );
}
