import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * The breathing dot — the honest "you are on the record" signal.
 *
 * The dot pulses only while audio is actually being captured, and its scale is
 * modulated by the live input level: if it moves with your voice, the microphone
 * really is picking you up. Reduced motion turns the pulse off centrally in the
 * token stylesheet; the state stays readable because it is also carried by the
 * glyph and the label.
 */
export function RecordingIndicator({
  active,
  level,
  className,
}: {
  active: boolean;
  /** Live input level, 0..1. */
  level: number;
  className?: string;
}) {
  const { t } = useTranslation();
  // A gentle ±10% around the resting size, as the component spec asks for.
  const scale = active ? 1 + Math.min(level, 1) * 0.1 : 1;

  return (
    <span
      role="status"
      aria-live="assertive"
      className={cn("inline-flex items-center gap-2", className)}
    >
      <span
        aria-hidden="true"
        style={active ? { transform: `scale(${scale.toFixed(3)})` } : undefined}
        className={cn(
          "size-2.5 rounded-full transition-transform duration-micro ease-enter",
          active
            ? "animate-recording-pulse bg-recording"
            : "border-2 border-recording bg-transparent",
        )}
      />
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
