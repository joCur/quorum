import * as React from "react";
import { Pencil, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isCorrected, type Segment, type SegmentOverlay, type Transcript } from "@quorum/shared";
import { SegmentEditor } from "@/components/meetings/segment-editor";
import {
  activeSegmentIndex,
  activeWordIndex,
  displayText,
  isLowConfidence,
  seekableWords,
  speakerLabel,
} from "@/features/meetings/transcript";
import { formatDuration } from "@/lib/duration";
import { cn } from "@/lib/utils";

/**
 * The transcript, synchronized with playback, and correctable in place.
 *
 * The transcript is the record of what was said, so nothing decorative happens inside the text:
 * the only styling that appears is the one that carries meaning — the active segment, the word
 * being spoken, an uncertain passage, and a passage its owner has corrected.
 */
export function TranscriptView({
  transcript,
  currentTime,
  onSeek,
  onCorrect,
  onReset,
}: {
  transcript: Transcript;
  currentTime: number;
  onSeek: (seconds: number) => void;
  /** Stores a segment's overlay. Rejects on failure, which the segment reports and recovers from. */
  onCorrect: (segmentId: string, overlay: SegmentOverlay) => Promise<void>;
  /** Takes a segment's correction back off, bringing the machine's own words back. */
  onReset: (segmentId: string) => Promise<void>;
}) {
  const activeIndex = React.useMemo(
    () => activeSegmentIndex(transcript.segments, currentTime),
    [transcript.segments, currentTime],
  );

  return (
    <div className="flex flex-col gap-5">
      {transcript.segments.map((segment, index) => (
        <SegmentBlock
          key={segment.id}
          transcript={transcript}
          segment={segment}
          active={index === activeIndex}
          currentTime={currentTime}
          index={index}
          onSeek={onSeek}
          onCorrect={onCorrect}
          onReset={onReset}
        />
      ))}
    </div>
  );
}

function SegmentBlock({
  transcript,
  segment,
  active,
  currentTime,
  index,
  onSeek,
  onCorrect,
  onReset,
}: {
  transcript: Transcript;
  segment: Segment;
  active: boolean;
  currentTime: number;
  index: number;
  onSeek: (seconds: number) => void;
  onCorrect: (segmentId: string, overlay: SegmentOverlay) => Promise<void>;
  onReset: (segmentId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const ref = React.useRef<HTMLDivElement>(null);
  const [editing, setEditing] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const speaker = speakerLabel(transcript, segment);
  const words = seekableWords(segment);
  const wordIndex = active && words ? activeWordIndex(segment, currentTime) : -1;
  const corrected = isCorrected(segment);

  React.useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-1 rounded-md px-3 py-2 transition-colors duration-large ease-enter",
        // Only the first few segments animate in: the beat is a welcome, not a queue to sit
        // through (COMPONENTS.md §10).
        index < 8 && "animate-rise-in",
        active && "bg-accent",
      )}
      style={index < 8 ? { animationDelay: `${index * 30}ms` } : undefined}
    >
      <div className="flex items-baseline gap-2.5">
        {speaker ? <span className="text-[13px] font-bold">{speaker}</span> : null}
        <button
          type="button"
          onClick={() => onSeek(segment.start)}
          className="font-mono text-[11.5px] text-honey-strong underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("meeting.transcript.jumpTo", { time: formatDuration(segment.start) })}
        >
          {formatDuration(segment.start)}
        </button>
        {isLowConfidence(segment) ? (
          <span className="text-xs text-muted-foreground" title={t("meeting.transcript.uncertain")}>
            {t("meeting.transcript.uncertainShort")}
          </span>
        ) : null}

        {/*
          A corrected passage says so, and the way back is next to the mark rather than hidden
          behind the editor: the machine's own words are still stored, and the control that brings
          them back belongs where the claim "this was changed" is made.
        */}
        {corrected ? (
          <span className="rounded-pill bg-honey/40 px-2 py-px text-[11px] font-semibold">
            {t("meeting.transcript.correction.marker")}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-0.5">
          {corrected && !editing ? (
            <button
              type="button"
              disabled={resetting}
              onClick={() => {
                setResetting(true);
                void onReset(segment.id).finally(() => setResetting(false));
              }}
              aria-label={t("meeting.transcript.correction.reset")}
              className="rounded-sm p-1 text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Undo2 aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
          {editing ? null : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={t("meeting.transcript.correction.edit", {
                time: formatDuration(segment.start),
              })}
              className="rounded-sm p-1 text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Pencil aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <SegmentEditor
          transcript={transcript}
          segment={segment}
          onCancel={() => setEditing(false)}
          onSave={async (overlay) => {
            await onCorrect(segment.id, overlay);
            setEditing(false);
          }}
        />
      ) : (
        <p
          className={cn(
            "max-w-[65ch] text-base leading-relaxed",
            // Uncertainty is marked by a dotted underline as well as the label above, so it does
            // not depend on reading one small word.
            isLowConfidence(segment) && "decoration-dotted underline decoration-muted-foreground",
          )}
        >
          {words
            ? words.map((word, position) => (
                <button
                  key={`${segment.id}-${String(position)}`}
                  type="button"
                  onClick={() => onSeek(word.start)}
                  className={cn(
                    "rounded-sm px-px text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    // The word being spoken is tinted honey — a block of background rather than a
                    // change of ink, so it is legible as a mark and not only as a color.
                    position === wordIndex && "bg-honey/45 font-semibold",
                  )}
                >
                  {word.word}
                  {position < words.length - 1 ? " " : ""}
                </button>
              ))
            : displayText(segment)}
        </p>
      )}
    </div>
  );
}
