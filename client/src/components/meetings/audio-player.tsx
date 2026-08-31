import * as React from "react";
import { Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/duration";
import type { AudioStatus } from "@/features/meetings/use-meeting-audio";
import { cn } from "@/lib/utils";

/** Skip step for the ±10s controls, and the smaller one the arrow keys use. */
const SKIP_SECONDS = 10;
const ARROW_SECONDS = 5;
const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export interface PlayerHandle {
  seekTo: (seconds: number) => void;
}

/** Shared shell so the loading, error and ready bars are one shape at one height. */
function PlayerBar({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "flex h-player-bar items-center gap-3 rounded-pill border border-border bg-card px-4 shadow-sm",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * Playback bar for a finished recording.
 *
 * The element is the source of truth for time: React state follows `timeupdate` rather than
 * driving it, so a seek from the transcript, a keyboard shortcut and the system's own media
 * controls all end up in the same place.
 *
 * The bar is a pill that sits directly under the top bar (COMPONENTS.md §9): a round play button,
 * a honey progress track with the two mono times under it, ±10s, and the rate as a mono pill. Its
 * height is the `--player-bar-height` token, because the summary rail beside it sticks below it
 * and computes its own offset from that number.
 */
export const AudioPlayer = React.forwardRef<
  PlayerHandle,
  {
    url: string | null;
    status: AudioStatus;
    /** Length from the transcript, used until the element knows its own duration. */
    fallbackDuration: number | null;
    onTimeUpdate: (seconds: number) => void;
    onRetry: () => void;
  }
>(function AudioPlayer({ url, status, fallbackDuration, onTimeUpdate, onRetry }, ref) {
  const { t } = useTranslation();
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState<number | null>(null);
  const [rate, setRate] = React.useState<number>(1);

  const seekTo = React.useCallback((seconds: number) => {
    const element = audioRef.current;
    if (!element) return;
    element.currentTime = Math.max(0, seconds);
  }, []);

  React.useImperativeHandle(ref, () => ({ seekTo }), [seekTo]);

  const total = duration ?? fallbackDuration ?? 0;
  const ready = status === "ready" && url !== null;
  const elapsed = total > 0 ? Math.min(currentTime / total, 1) : 0;

  const toggle = (): void => {
    const element = audioRef.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  };

  const skip = (delta: number): void => {
    const element = audioRef.current;
    if (!element) return;
    seekTo(element.currentTime + delta);
  };

  /** The rate control is one button that steps through the list and wraps, as the design shows. */
  const cycleRate = (): void => {
    const next = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length] ?? 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Only the shortcuts the design names, and never while the user is inside the slider — the
    // range input has its own arrow-key behavior and stealing it would be worse than helpful.
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === " ") {
      event.preventDefault();
      toggle();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      skip(-ARROW_SECONDS);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      skip(ARROW_SECONDS);
    }
  };

  if (status === "loading" || status === "idle") {
    return (
      <PlayerBar>
        <Skeleton className="size-[42px] shrink-0 rounded-full" />
        <Skeleton className="h-2 flex-1 rounded-full" />
        <Skeleton className="h-4 w-16" />
      </PlayerBar>
    );
  }

  if (status === "error" || !ready) {
    return (
      <PlayerBar className="justify-between gap-3 pr-2">
        <span className="truncate text-sm text-destructive">{t("meeting.player.unavailable")}</span>
        <Button variant="ghost" size="sm" className="rounded-pill" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </PlayerBar>
    );
  }

  return (
    // The shortcuts live on the group rather than on any single control: they belong to the
    // player as a whole, which is what the design describes as "when the player is focused".
    <PlayerBar
      role="group"
      tabIndex={-1}
      aria-label={t("meeting.player.label")}
      onKeyDown={onKeyDown}
      className="gap-3 shell:gap-3.5"
    >
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          // A stream without a cue index reports Infinity until it has been played through.
          setDuration(Number.isFinite(value) ? value : null);
        }}
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime;
          setCurrentTime(time);
          onTimeUpdate(time);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t("meeting.player.pause") : t("meeting.player.play")}
        className="grid size-[42px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-transform duration-micro ease-spring active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {playing ? (
          <Pause aria-hidden="true" className="size-4 fill-current" />
        ) : (
          <Play aria-hidden="true" className="size-4 fill-current" />
        )}
      </button>

      {/* Track and times are one column: the bar reads as a single progress object rather than a
          row of separate controls with numbers wedged between them. */}
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <input
          type="range"
          min={0}
          max={total || 0}
          step={0.1}
          value={Math.min(currentTime, total || 0)}
          disabled={total === 0}
          onChange={(event) => seekTo(Number(event.target.value))}
          aria-label={t("meeting.player.seek")}
          aria-valuetext={formatDuration(currentTime)}
          // The honey fill is painted as a gradient on the track itself rather than with
          // `accent-color`: the design's progress is a filled bar, and a native accent only
          // colors the thumb in the browsers that honor it at all. Keeping the real range input
          // is what preserves keyboard seeking and the announced position.
          style={{
            backgroundImage: `linear-gradient(to right, hsl(var(--honey-strong)) ${String(elapsed * 100)}%, transparent ${String(elapsed * 100)}%)`,
          }}
          className={cn(
            // 10px of box for an 8px groove: the border sits outside the fill, as the design
            // draws it, and `border-box` sizing would otherwise eat two of the eight pixels and
            // leave the bar visibly thin.
            "h-2.5 w-full cursor-pointer appearance-none rounded-[5px] border border-border bg-background bg-no-repeat",
            // The thumb is the width of the groove and the color of the fill, so at rest it is
            // the end of the bar rather than a dot riding on top of it — the design has no
            // separate handle, and a larger one broke the bar's line.
            "[&::-webkit-slider-thumb]:size-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-honey-strong",
            "[&::-moz-range-thumb]:size-2 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-honey-strong",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        />
        <div className="flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
          <span>{formatDuration(currentTime)}</span>
          <span>{total > 0 ? formatDuration(total) : "--:--"}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => skip(-SKIP_SECONDS)}
        aria-label={t("meeting.player.back", { seconds: SKIP_SECONDS })}
        className="hidden shrink-0 rounded-pill p-1.5 text-[12.5px] font-bold text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
      >
        {t("meeting.player.backShort", { seconds: SKIP_SECONDS })}
      </button>

      <button
        type="button"
        onClick={() => skip(SKIP_SECONDS)}
        aria-label={t("meeting.player.forward", { seconds: SKIP_SECONDS })}
        className="hidden shrink-0 rounded-pill p-1.5 text-[12.5px] font-bold text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
      >
        {t("meeting.player.forwardShort", { seconds: SKIP_SECONDS })}
      </button>

      {/* One button that steps through the rates rather than a select: the value is its own
          label, and the name it is announced with carries both the control and the current rate. */}
      <button
        type="button"
        onClick={cycleRate}
        aria-label={`${t("meeting.player.rate")}: ${t("meeting.player.rateValue", { rate })}`}
        className="shrink-0 rounded-pill border border-border px-2.5 py-1.5 font-mono text-xs font-bold tabular-nums text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("meeting.player.rateValue", { rate })}
      </button>
    </PlayerBar>
  );
});
