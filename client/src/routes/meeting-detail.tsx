import * as React from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { MeetingDetail } from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioPlayer, type PlayerHandle } from "@/components/meetings/audio-player";
import { DeleteMeetingDialog } from "@/components/meetings/delete-meeting-dialog";
import { PipelineStepper } from "@/components/meetings/pipeline-stepper";
import { StatusBadge } from "@/components/meetings/status-badge";
import { SummaryView } from "@/components/meetings/summary-view";
import { TranscriptView } from "@/components/meetings/transcript-view";
import { formatMeetingDate, formatMeetingDuration, meetingLabel } from "@/features/meetings/format";
import { isPipelineComplete } from "@/features/meetings/pipeline";
import { useMeeting } from "@/features/meetings/use-meeting";
import { useMeetingAudio } from "@/features/meetings/use-meeting-audio";
import { cn } from "@/lib/utils";

type TabKey = "transcript" | "summary";

export function MeetingDetailRoute() {
  const { meetingId = "" } = useParams();
  const meeting = useMeeting(meetingId);

  if (meeting.status === "loading") return <DetailSkeleton />;
  if (meeting.status === "missing") return <DeletedNotice />;
  if (meeting.status === "error" || !meeting.detail) {
    return <LoadError code={meeting.errorCode} onRetry={meeting.reload} />;
  }

  return (
    <MeetingDetailScreen
      detail={meeting.detail}
      deleting={meeting.deleting}
      onDelete={meeting.remove}
    />
  );
}

function MeetingDetailScreen({
  detail,
  deleting,
  onDelete,
}: {
  detail: MeetingDetail;
  deleting: boolean;
  onDelete: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = React.useState<TabKey>("transcript");
  const [confirming, setConfirming] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const player = React.useRef<PlayerHandle>(null);

  const { meeting, transcript, summaries } = detail;
  const audio = useMeetingAudio(meeting.id, meeting.hasAudio);
  const duration = formatMeetingDuration(meeting);
  const title = meeting.title?.trim() || t("meetings.untitled");
  const summary = summaries[0] ?? null;

  const seek = React.useCallback((seconds: number) => {
    player.current?.seekTo(seconds);
  }, []);

  return (
    /*
      The column fills the height `main` gives it and cancels `main`'s bottom padding, replacing
      it with padding equal to the player's own resting offset. That makes the content box end
      exactly where the bar belongs: `mt-auto` then drops the bar onto the viewport's bottom edge
      when the page does not scroll, and `sticky` holds it at the identical offset when it does —
      so the bar never jumps between the two cases.
    */
    <div className="-mb-28 flex flex-1 flex-col gap-5 pb-16 md:-mb-10 md:pb-4">
      <div className="flex flex-col gap-2">
        <Link
          to="/meetings"
          className="flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("meeting.back")}
        </Link>

        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-xl font-bold md:text-2xl">{title}</h1>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{formatMeetingDate(meeting.createdAt, i18n.language)}</span>
              {duration ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{duration}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge status={meeting.status} />
            <Button
              variant="ghost"
              size="icon"
              disabled={deleting}
              onClick={() => setConfirming(true)}
              aria-label={t("meetings.delete.action", { meeting: title })}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      {/* The stepper is the waiting readout; once everything is done it has nothing left to
          report and disappears rather than standing there saying so (STATES.md §9). */}
      {isPipelineComplete(detail) ? null : <PipelineStepper detail={detail} />}

      <Tabs
        value={tab}
        onValueChange={setTab}
        transcriptReady={transcript !== null}
        summaryReady={summary !== null}
      />

      {tab === "transcript" ? (
        <TranscriptPanel detail={detail} currentTime={currentTime} onSeek={seek} />
      ) : (
        <SummaryPanel detail={detail} />
      )}

      {/*
        Sticky rather than fixed: a fixed bar is positioned against the viewport, so once the
        sidebar appears at `md` it reaches underneath it and centers on the wrong axis. Sticking
        the last element of the content column keeps the player exactly as wide as the column at
        every breakpoint, with no offset to keep in sync with the sidebar's width.

        `mt-auto` handles the short-content case: with nothing to scroll, sticky alone would
        leave the bar floating directly under the last segment, so the auto margin eats the free
        space and pushes it to the bottom of the column instead.

        `bottom-16` clears the mobile tab bar (the same `h-16`); from `md` up the tab bar is gone
        and a small inset is enough. Both values match the column's padding above, which is what
        keeps the resting and pinned positions identical.
      */}
      {meeting.hasAudio ? (
        <div className="sticky bottom-16 z-20 mt-auto md:bottom-4">
          <AudioPlayer
            ref={player}
            url={audio.url}
            status={audio.status}
            fallbackDuration={meeting.durationSeconds}
            onTimeUpdate={setCurrentTime}
            onRetry={audio.reload}
          />
        </div>
      ) : null}

      <DeleteMeetingDialog
        open={confirming}
        onOpenChange={setConfirming}
        meetingLabel={meetingLabel(meeting, i18n.language, t("meetings.untitled"))}
        onConfirm={() => {
          setConfirming(false);
          void onDelete().then(() => navigate("/meetings"));
        }}
      />
    </div>
  );
}

/**
 * Tab strip. The panels carry independent state, because partial readiness is the normal case:
 * a finished transcript next to a summary still being written (STATES.md §4).
 */
function Tabs({
  value,
  onValueChange,
  transcriptReady,
  summaryReady,
}: {
  value: TabKey;
  onValueChange: (value: TabKey) => void;
  transcriptReady: boolean;
  summaryReady: boolean;
}) {
  const { t } = useTranslation();
  const tabs: readonly { key: TabKey; ready: boolean }[] = [
    { key: "transcript", ready: transcriptReady },
    { key: "summary", ready: summaryReady },
  ];

  return (
    <div
      role="tablist"
      aria-label={t("meeting.tabs.label")}
      className="flex gap-1 border-b border-border"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          type="button"
          id={`tab-${tab.key}`}
          aria-selected={value === tab.key}
          aria-controls={`panel-${tab.key}`}
          onClick={() => onValueChange(tab.key)}
          onKeyDown={(event) => {
            // Arrow keys move between tabs, as the tab pattern requires.
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            onValueChange(tab.key === "transcript" ? "summary" : "transcript");
          }}
          className={cn(
            "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-micro ease-enter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === tab.key
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`meeting.tabs.${tab.key}`)}
          {tab.ready ? (
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 animate-pop-in rounded-full",
                tab.key === "summary" ? "bg-plum" : "bg-success",
              )}
            />
          ) : null}
        </button>
      ))}
    </div>
  );
}

function TranscriptPanel({
  detail,
  currentTime,
  onSeek,
}: {
  detail: MeetingDetail;
  currentTime: number;
  onSeek: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  const failure = detail.meeting.failure;

  return (
    <div role="tabpanel" id="panel-transcript" aria-labelledby="tab-transcript">
      {failure?.stage === "transcribe" ? (
        <FailurePanel
          title={t("meeting.transcript.failed")}
          message={failure.message}
          code={failure.code}
        />
      ) : detail.transcript ? (
        <TranscriptView transcript={detail.transcript} currentTime={currentTime} onSeek={onSeek} />
      ) : (
        <WaitingPanel message={t("meeting.transcript.working")} />
      )}
    </div>
  );
}

function SummaryPanel({ detail }: { detail: MeetingDetail }) {
  const { t } = useTranslation();
  const failure = detail.meeting.failure;
  const summary = detail.summaries[0] ?? null;

  return (
    <div role="tabpanel" id="panel-summary" aria-labelledby="tab-summary">
      {failure?.stage === "summarize" ? (
        <FailurePanel
          title={t("meeting.summary.failed")}
          message={failure.message}
          code={failure.code}
        />
      ) : summary ? (
        <SummaryView summary={summary} />
      ) : (
        <WaitingPanel message={t("meeting.summary.working")} />
      )}
    </div>
  );
}

/** Waiting is rendered as work in progress, not as emptiness (STATES.md §4). */
function WaitingPanel({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">{message}</p>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  );
}

/**
 * A failed stage is reported in place, not as a toast — it is a standing condition. Everything
 * that succeeded stays usable: the audio player and the other tab are untouched (STATES.md §5).
 */
function FailurePanel({ title, message, code }: { title: string; message: string; code: string }) {
  return (
    <Card className="flex flex-col gap-2 p-5">
      <h2 className="font-semibold text-destructive">{title}</h2>
      <p className="text-sm text-muted-foreground">{message}</p>
      <p className="font-mono text-xs text-muted-foreground">{code}</p>
    </Card>
  );
}

function DetailSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-5" role="status" aria-label={t("common.loading")}>
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-9 w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-9/12" />
      </div>
    </div>
  );
}

/** Calm, not playful: the meeting is gone because someone chose that (STATES.md §6). */
function DeletedNotice() {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-muted-foreground">{t("meeting.deleted")}</p>
      <Button variant="ghost" asChild>
        <Link to="/meetings">{t("meeting.back")}</Link>
      </Button>
    </Card>
  );
}

function LoadError({ code, onRetry }: { code: string | null; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p className="text-destructive">{t("meeting.loadError")}</p>
      {code ? <p className="font-mono text-xs text-muted-foreground">{code}</p> : null}
      <Button variant="outline" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </Card>
  );
}
