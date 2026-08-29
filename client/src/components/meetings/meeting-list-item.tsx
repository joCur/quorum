import { Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { Meeting } from "@quorum/shared";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/meetings/status-badge";
import { formatMeetingDate, formatMeetingDuration } from "@/features/meetings/format";
import { cn } from "@/lib/utils";

/**
 * One row of the meeting list.
 *
 * The whole row is the link to the meeting, so a tap anywhere opens it; the delete control sits
 * outside that link rather than inside it, because a button nested in an anchor is neither valid
 * markup nor predictable for a screen reader.
 *
 * A failed meeting keeps every control it had: a failed summary does not make the audio or the
 * transcript any less available (STATES.md §5).
 */
export function MeetingListItem({
  meeting,
  index,
  deleting,
  onDelete,
}: {
  meeting: Meeting;
  /** Position in the list, for the staggered entrance. */
  index: number;
  deleting: boolean;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const duration = formatMeetingDuration(meeting);
  const title = meeting.title?.trim() || t("meetings.untitled");

  return (
    <Card
      className={cn(
        "animate-rise-in flex items-center gap-3 p-3 transition-shadow duration-micro ease-enter md:p-4",
        deleting ? "pointer-events-none opacity-50" : "hover:shadow-md",
      )}
      // Capped so a long list does not end in a visible wave; rows past the tenth just appear.
      style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
    >
      <Link
        to={`/meetings/${meeting.id}`}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="truncate font-semibold">{title}</span>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{formatMeetingDate(meeting.createdAt, i18n.language)}</span>
          {duration ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{duration}</span>
            </>
          ) : null}
        </span>
      </Link>

      {deleting ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          {t("meetings.delete.inProgress")}
        </span>
      ) : (
        <StatusBadge status={meeting.status} />
      )}

      <Button
        variant="ghost"
        size="icon"
        disabled={deleting}
        onClick={onDelete}
        aria-label={t("meetings.delete.action", { meeting: title })}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </Card>
  );
}
