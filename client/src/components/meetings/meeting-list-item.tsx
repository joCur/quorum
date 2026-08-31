import { Check, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { Meeting } from "@quorum/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/meetings/status-badge";
import { formatMeetingDuration, formatMeetingTime } from "@/features/meetings/format";
import type { DayGroup } from "@/features/meetings/grouping";
import { isInProgress } from "@/features/meetings/status";
import { cn } from "@/lib/utils";

/**
 * One row of the meeting list.
 *
 * The row reads left to right as length · what it was · when: the duration sits in a fixed
 * right-aligned mono column so the numbers line up down the whole panel and the titles all start
 * at the same place. The whole title block is the link to the meeting, so a tap anywhere on it
 * opens the meeting; the delete control sits outside that link rather than inside it, because a
 * button nested in an anchor is neither valid markup nor predictable for a screen reader.
 *
 * A failed meeting keeps every control it had: a failed summary does not make the audio or the
 * transcript any less available (STATES.md §5).
 */
export function MeetingListItem({
  meeting,
  group,
  index,
  deleting,
  justFinished,
  onDelete,
}: {
  meeting: Meeting;
  /** The day bucket this row sits in, which decides how short its time can be. */
  group: DayGroup;
  /** Position in the list, for the staggered entrance. */
  index: number;
  deleting: boolean;
  /** True for the moment after the meeting finished while the user was watching. */
  justFinished: boolean;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const duration = formatMeetingDuration(meeting);
  const title = meeting.title?.trim() || t("meetings.untitled");

  return (
    <div
      className={cn(
        "animate-rise-in flex items-center gap-3.5 px-4 py-[15px] transition-colors duration-micro ease-enter md:px-[18px]",
        deleting ? "pointer-events-none opacity-50" : "hover:bg-muted/40",
      )}
      // Capped so a long list does not end in a visible wave; rows past the tenth just appear.
      style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
    >
      {/* A fixed column rather than an intrinsic one: the widths differ ("2:18" vs "1:02:05")
          and a column that resized per row would undo the alignment it exists for. */}
      <span className="w-[74px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {duration}
      </span>

      <Link
        to={`/meetings/${meeting.id}`}
        className="flex min-w-0 flex-1 flex-col gap-[3px] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="truncate font-bold">{title}</span>
        <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{formatMeetingTime(meeting.createdAt, i18n.language, group)}</span>
          <RowStatus meeting={meeting} deleting={deleting} justFinished={justFinished} />
        </span>
      </Link>

      <Button
        variant="ghost"
        size="icon"
        disabled={deleting}
        onClick={onDelete}
        aria-label={t("meetings.delete.action", { meeting: title })}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * What the row says about the meeting's state — which, most of the time, is nothing.
 *
 * A finished meeting is the normal case and carries no chip; the row being there is the whole
 * message. Only work in progress, a failure, and the brief moment of arrival earn one.
 */
function RowStatus({
  meeting,
  deleting,
  justFinished,
}: {
  meeting: Meeting;
  deleting: boolean;
  justFinished: boolean;
}) {
  const { t } = useTranslation();

  if (deleting) {
    return (
      <span className="flex items-center gap-1.5">
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
        {t("meetings.delete.inProgress")}
      </span>
    );
  }

  if (meeting.status === "ready") {
    if (!justFinished) return null;
    return (
      <Badge variant="success">
        <Check aria-hidden="true" />
        {t("meetings.status.done")}
      </Badge>
    );
  }

  return (
    <StatusBadge
      status={meeting.status}
      // Shimmer marks the stage that is actually running, and only that one (MOTION §10).
      className={cn(
        isInProgress(meeting.status) &&
          meeting.status !== "recording" &&
          "bg-[linear-gradient(90deg,transparent_25%,hsl(var(--info)/0.12)_50%,transparent_75%)] bg-[length:200%_100%] animate-shimmer motion-reduce:animate-none",
      )}
    />
  );
}
