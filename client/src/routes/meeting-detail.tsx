import * as React from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  hasCorrections,
  isRetryableJobErrorCode,
  type MeetingDetail,
  type SegmentOverlay,
} from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioPlayer, type PlayerHandle } from "@/components/meetings/audio-player";
import { DeleteMeetingDialog } from "@/components/meetings/delete-meeting-dialog";
import { MeetingTitleField } from "@/components/meetings/meeting-title-field";
import { PipelineStepper } from "@/components/meetings/pipeline-stepper";
import { RegenerateSummary } from "@/components/meetings/regenerate-summary";
import { RetryTranscription } from "@/components/meetings/retry-transcription";
import { SummaryAttribution, SummaryView } from "@/components/meetings/summary-view";
import { TranscriptView } from "@/components/meetings/transcript-view";
import { formatMeetingDate, formatMeetingDuration, meetingLabel } from "@/features/meetings/format";
import { asLimitCode, limitMessageKey } from "@/features/limits/messages";
import { failedJob, failedJobId, failureMessageKey } from "@/features/meetings/failure";
import { isPipelineComplete } from "@/features/meetings/pipeline";
import { useMeeting } from "@/features/meetings/use-meeting";
import { useMeetingAudio } from "@/features/meetings/use-meeting-audio";
import { useSummaryRegeneration } from "@/features/templates/use-regenerate";
import { useTemplates } from "@/features/templates/use-templates";
import { cn } from "@/lib/utils";

/**
 * Which half of the meeting a narrow screen is showing.
 *
 * Only narrow screens have to choose: from the shell breakpoint up, the transcript and the
 * summary stand side by side and this state stops deciding anything.
 */
type ViewKey = "summary" | "transcript";

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
      onReload={meeting.reload}
      onRename={meeting.rename}
      onCorrect={meeting.correct}
      onResetSegment={meeting.reset}
    />
  );
}

function MeetingDetailScreen({
  detail,
  deleting,
  onDelete,
  onReload,
  onRename,
  onCorrect,
  onResetSegment,
}: {
  detail: MeetingDetail;
  deleting: boolean;
  onDelete: () => Promise<void>;
  onReload: () => void;
  onRename: (title: string) => Promise<void>;
  onCorrect: (segmentId: string, overlay: SegmentOverlay) => Promise<void>;
  onResetSegment: (segmentId: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // The summary is what most people open a finished meeting for, so it is the half a narrow
  // screen starts on; the transcript is one tap away and is the whole record, not the answer.
  const [view, setView] = React.useState<ViewKey>("summary");
  const [confirming, setConfirming] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const player = React.useRef<PlayerHandle>(null);

  const { meeting } = detail;
  const audio = useMeetingAudio(meeting.id, meeting.hasAudio);
  const duration = formatMeetingDuration(meeting);
  const title = meeting.title?.trim() || t("meetings.untitled");

  const seek = React.useCallback((seconds: number) => {
    player.current?.seekTo(seconds);
  }, []);

  return (
    <div className="flex flex-1 flex-col gap-[18px]">
      {/*
        An ordinary block at every width. This used to pin itself to the top edge below `md`,
        because the shell dropped its tab bar here and the back link was then the only way out.
        The top bar is on this screen now like every other, so the header can scroll away with
        the content it belongs to.
      */}
      <div className="flex flex-col gap-2">
        <Link
          to="/meetings"
          className="flex w-fit items-center gap-1 rounded-sm py-1 text-[13.5px] font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("meeting.back")}
        </Link>

        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <MeetingTitleField
              title={meeting.title?.trim() || null}
              placeholder={t("meetings.untitled")}
              onRename={onRename}
            />
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
          {/*
            No status chip here. While there is work to report the stepper below reports it, in
            more detail than a chip could; once everything is done there is nothing to say, and a
            standing green "Ready" would be the screen talking about itself (STATES.md §9).

            The delete control is a bordered pill rather than a bare icon: it is the only
            destructive thing on the screen, and an outline is what tells it apart from the copy
            icons inside the summary.
          */}
          <button
            type="button"
            disabled={deleting}
            onClick={() => setConfirming(true)}
            aria-label={t("meetings.delete.action", { meeting: title })}
            className="flex shrink-0 items-center rounded-pill border border-border bg-card px-3 py-[9px] text-muted-foreground transition-colors duration-micro ease-enter hover:border-destructive/40 hover:text-destructive disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      {/* The stepper is the waiting readout; once everything is done it has nothing left to
          report and disappears rather than standing there saying so (STATES.md §9). */}
      {isPipelineComplete(detail) ? null : <PipelineStepper detail={detail} />}

      {/*
        The player sits directly under the top bar rather than on the bottom edge: the transcript
        scrolls past it, so the control that moves the playhead stays next to the words it moves
        through. Both offsets come from the same tokens the bar sets its own height from, which
        is what keeps them from overlapping.
      */}
      {meeting.hasAudio ? (
        <div className="sticky top-[calc(var(--top-bar-height)_+_12px)] z-20">
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

      <ViewSwitch value={view} onValueChange={setView} />

      {/*
        Side by side from the shell breakpoint up, one at a time below it. The two halves keep
        independent state, because partial readiness is the normal case: a finished transcript
        next to a summary still being written (STATES.md §4).
      */}
      <div className="flex flex-wrap items-start gap-7">
        <section
          aria-labelledby="transcript-heading"
          className={cn(
            "min-w-0 flex-[1_1_380px] flex-col gap-4 shell:flex",
            view === "transcript" ? "flex" : "hidden",
          )}
        >
          <ColumnHeading id="transcript-heading">{t("meeting.view.transcript")}</ColumnHeading>
          <TranscriptPanel
            detail={detail}
            currentTime={currentTime}
            onSeek={seek}
            onReload={onReload}
            onCorrect={onCorrect}
            onResetSegment={onResetSegment}
          />
        </section>

        {/*
          The summary is a rail: it is the shorter half and the one people read while scanning
          the transcript, so it stays put while the transcript scrolls past it. It rests below
          the player when there is one, and directly under the top bar when there is not.
        */}
        <section
          aria-labelledby="summary-heading"
          className={cn(
            "min-w-0 flex-[1_1_320px] flex-col gap-3.5 shell:sticky shell:flex",
            view === "summary" ? "flex" : "hidden",
            meeting.hasAudio
              ? "shell:top-[calc(var(--top-bar-height)_+_var(--player-bar-height)_+_30px)]"
              : "shell:top-[calc(var(--top-bar-height)_+_18px)]",
          )}
        >
          <ColumnHeading id="summary-heading">{t("meeting.view.summary")}</ColumnHeading>
          <SummaryPanel detail={detail} onReload={onReload} />
        </section>
      </div>

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
 * The switch between the two halves, on the screens that can only show one.
 *
 * It is a pair of toggles rather than a tab strip, and it disappears above the shell breakpoint:
 * wider screens show both halves at once, and a tab pattern there would claim that one of two
 * visible panels is hidden. Both halves stay mounted at every width, so switching costs nothing
 * and neither of them loses its place.
 */
function ViewSwitch({
  value,
  onValueChange,
}: {
  value: ViewKey;
  onValueChange: (value: ViewKey) => void;
}) {
  const { t } = useTranslation();
  const views: readonly ViewKey[] = ["summary", "transcript"];

  return (
    <div
      role="group"
      aria-label={t("meeting.view.label")}
      className="flex gap-0.5 self-start rounded-pill border border-border bg-card p-[3px] shell:hidden"
    >
      {views.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onValueChange(key)}
          className={cn(
            // `leading-tight` rather than the inherited body leading: the design sizes these pills
            // from their text, and 1.5 line-height would quietly make them 4px taller than the
            // switch they sit in was drawn to be.
            "rounded-pill px-[18px] py-2 text-[13.5px] font-bold leading-tight transition-colors duration-micro ease-enter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`meeting.view.${key}`)}
        </button>
      ))}
    </div>
  );
}

/**
 * The name of a half.
 *
 * Visible only where both halves are on screen and need telling apart; below that the switch
 * above already says which one is showing, so the heading stays for assistive technology and
 * takes no room.
 */
function ColumnHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="sr-only font-sans text-section-label uppercase text-muted-foreground shell:not-sr-only"
    >
      {children}
    </h2>
  );
}

function TranscriptPanel({
  detail,
  currentTime,
  onSeek,
  onReload,
  onCorrect,
  onResetSegment,
}: {
  detail: MeetingDetail;
  currentTime: number;
  onSeek: (seconds: number) => void;
  onReload: () => void;
  onCorrect: (segmentId: string, overlay: SegmentOverlay) => Promise<void>;
  onResetSegment: (segmentId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const failure = detail.meeting.failure;
  const job = failedJob(detail, "transcribe");

  return (
    <div>
      {failure?.stage === "transcribe" ? (
        <FailurePanel
          title={t("meeting.transcript.failed")}
          code={failure.code}
          jobId={job?.id ?? null}
          // Offered only where another attempt could end differently. The taxonomy is the
          // pipeline's own (`shared/src/job.ts`), so the action appears exactly where the server
          // would accept it: no dead control, and no refusal the user could not have foreseen.
          action={
            isRetryableJobErrorCode(failure.code) ? (
              <RetryTranscription
                meetingId={detail.meeting.id}
                failedAt={job?.finishedAt ?? null}
                onReload={onReload}
              />
            ) : null
          }
        />
      ) : detail.transcript ? (
        <TranscriptView
          transcript={detail.transcript}
          currentTime={currentTime}
          onSeek={onSeek}
          onCorrect={onCorrect}
          onReset={onResetSegment}
        />
      ) : (
        <WaitingPanel message={t("meeting.transcript.working")} />
      )}
    </div>
  );
}

/**
 * The summary, the template it was made with, and the action to make it again.
 *
 * While a new summary is being written the previous one stays on screen, dimmed and labeled as
 * the previous version (COMPONENTS.md §11): nothing vanishes optimistically, because the old
 * summary is the only one that exists until the new one is stored.
 */
function SummaryPanel({ detail, onReload }: { detail: MeetingDetail; onReload: () => void }) {
  const { t } = useTranslation();
  const failure = detail.meeting.failure;
  const templates = useTemplates();

  // Summaries arrive oldest first; the newest is what a screen with no choice made yet should
  // show, and its template is what the picker opens on.
  const newest = detail.summaries.at(-1) ?? null;
  const [templateId, setTemplateId] = React.useState<string | null>(null);
  const selected =
    templateId ?? newest?.templateSnapshot.templateId ?? templates.templates[0]?.template.id ?? "";

  const forSelected =
    detail.summaries.find((entry) => entry.templateSnapshot.templateId === selected) ?? null;
  // While the chosen template has no summary yet, the newest one stays on screen rather than the
  // panel going blank — nothing vanishes before its replacement exists.
  const summary = forSelected ?? newest;
  const regeneration = useSummaryRegeneration(detail.meeting.id, forSelected?.id ?? null, onReload);

  const templateName =
    templates.templates.find((view) => view.template.id === summary?.templateSnapshot.templateId)
      ?.template.name ?? null;

  return (
    <div className="flex flex-col gap-3.5">
      {regeneration.errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {regenerationMessage(t, regeneration.errorCode) ?? regeneration.errorMessage}
        </p>
      ) : null}

      {failure?.stage === "summarize" && !regeneration.pending ? (
        <FailurePanel
          title={t("meeting.summary.failed")}
          code={failure.code}
          jobId={failedJobId(detail, "summarize")}
        />
      ) : summary ? (
        <div className={cn("flex flex-col gap-2", regeneration.pending && "opacity-60")}>
          {regeneration.pending ? (
            <p className="text-sm text-muted-foreground">{t("meeting.summary.previousVersion")}</p>
          ) : null}
          <SummaryView summary={summary} />
        </div>
      ) : (
        <WaitingPanel message={t("meeting.summary.working")} />
      )}

      {/*
        The foot of the rail: where this summary came from, and the control that replaces it.
        Making it again is what you reach for after reading it, so both sit under the sections
        rather than above them, and they sit together — the line names the template the picker
        is set to.
      */}
      {summary || detail.transcript ? (
        <div className="flex flex-col gap-2.5 px-0.5 py-1">
          {summary ? <SummaryAttribution summary={summary} templateName={templateName} /> : null}
          {/*
            Every summary is written from the transcript the machine produced — the pipeline never
            reads the corrections (ADR-011) — so a corrected transcript means the summary describes
            wording that is no longer on screen. The note says that and nothing more: the summary is
            not wrong, and the person who made the correction is the one who can judge whether it
            matters. It follows the existence of a correction rather than its time, because a new
            summary reads the original wording exactly like the old one did.
          */}
          {summary && detail.transcript && hasCorrections(detail.transcript) ? (
            <p className="text-[13px] text-muted-foreground">
              {t("meeting.summary.fromOriginalWording")}
            </p>
          ) : null}
          {detail.transcript ? (
            <RegenerateSummary
              templates={templates.templates}
              templateId={selected}
              onTemplateChange={setTemplateId}
              pending={regeneration.pending}
              onRegenerate={regeneration.start}
            />
          ) : null}
        </div>
      ) : null}
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
 * that succeeded stays usable: the audio player and the other half are untouched (STATES.md §5).
 *
 * The sentence comes from the error code, never from the pipeline's own message: that message is
 * written for logs and may quote a backend verbatim, which is neither the user's language nor
 * anything the product talks about (ADR-005). The code and the job reference stay reachable one
 * click down, where support can ask for them without the screen leading with them.
 *
 * `action` is the way out, where there is one. It sits between the sentence and the technical
 * details, because that is the order the reader needs them in: what happened, what to do about
 * it, and only then the reference a support request would quote.
 */
function FailurePanel({
  title,
  code,
  jobId,
  action = null,
}: {
  title: string;
  code: string;
  jobId: string | null;
  action?: React.ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <Card className="flex flex-col gap-2 p-5">
      <h2 className="font-semibold text-destructive">{title}</h2>
      <p className="text-sm text-muted-foreground">{t(failureMessageKey(code))}</p>
      {action}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">{t("meeting.failure.details")}</summary>
        <p className="mt-1 font-mono">{t("meeting.failure.detailsCode", { code })}</p>
        {jobId ? (
          <p className="font-mono">{t("meeting.failure.detailsReference", { id: jobId })}</p>
        ) : null}
      </details>
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

/**
 * The refusals a regenerate can come back with, in the user's language.
 *
 * A limit is one of them: asking for a summary again is the one request that costs a model call,
 * so it has a much smaller allowance than the rest of the API and is the request most likely to
 * meet it. Anything this does not recognize keeps the server's own message, which is still more
 * useful than a generic sentence.
 */
function regenerationMessage(t: TFunction, code: string | null): string | null {
  if (code === "summary_in_progress") return t("meeting.summary.alreadyRunning");
  const limit = asLimitCode(code);
  return limit === null ? null : t(limitMessageKey(limit));
}
