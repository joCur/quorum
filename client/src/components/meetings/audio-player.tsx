import * as React from "react";
import { Loader2, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/duration";
import type { AudioStatus } from "@/features/meetings/use-meeting-audio";
import { cn } from "@/lib/utils";

/** Skip step for the ±15s controls and the arrow keys. */
const SKIP_SECONDS = 15;
const ARROW_SECONDS = 5;
const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export interface PlayerHandle {
  seekTo: (seconds: number) => void;
}

/**
 * Playback bar for a finished recording.
 *
 * The element is the source of truth for time: React state follows `timeupdate` rather than
 * driving it, so a seek from the transcript, a keyboard shortcut and the system's own media
 * controls all end up in the same place.
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
      <div className="flex items-center gap-3 rounded-full border border-border bg-card p-2 pr-4">
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="h-2 flex-1 rounded-full" />
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  if (status === "error" || !ready) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-full border border-border bg-card py-2 pl-5 pr-2">
        <span className="text-sm text-destructive">{t("meeting.player.unavailable")}</span>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    // The shortcuts live on the group rather than on any single control: they belong to the
    // player as a whole, which is what the design describes as "when the player is focused".
    <div
      role="group"
      tabIndex={-1}
      aria-label={t("meeting.player.label")}
      onKeyDown={onKeyDown}
      className="flex items-center gap-2 rounded-full border border-border bg-card p-2 shadow-sm md:gap-3 md:pr-4"
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

      <Button
        size="icon"
        className="rounded-full"
        onClick={toggle}
        aria-label={playing ? t("meeting.player.pause") : t("meeting.player.play")}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="hidden rounded-full sm:inline-flex"
        onClick={() => skip(-SKIP_SECONDS)}
        aria-label={t("meeting.player.back", { seconds: SKIP_SECONDS })}
      >
        <RotateCcw aria-hidden="true" />
      </Button>

      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {formatDuration(currentTime)}
      </span>

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
        className={cn(
          "h-1 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      />

      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {total > 0 ? formatDuration(total) : "--:--"}
      </span>

      <Button
        variant="ghost"
        size="icon"
        className="hidden rounded-full sm:inline-flex"
        onClick={() => skip(SKIP_SECONDS)}
        aria-label={t("meeting.player.forward", { seconds: SKIP_SECONDS })}
      >
        <RotateCw aria-hidden="true" />
      </Button>

      <label className="sr-only" htmlFor="playback-rate">
        {t("meeting.player.rate")}
      </label>
      <select
        id="playback-rate"
        value={rate}
        onChange={(event) => {
          const next = Number(event.target.value);
          setRate(next);
          if (audioRef.current) audioRef.current.playbackRate = next;
        }}
        className="h-9 rounded-full border border-input bg-background px-2 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {RATES.map((value) => (
          <option key={value} value={value}>
            {value}×
          </option>
        ))}
      </select>

      {status !== "ready" ? (
        <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      ) : null}
    </div>
  );
});
