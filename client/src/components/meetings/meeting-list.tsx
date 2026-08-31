import * as React from "react";
import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { Meeting } from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/empty-state";
import { DeleteMeetingDialog } from "@/components/meetings/delete-meeting-dialog";
import { MeetingListItem } from "@/components/meetings/meeting-list-item";
import { formatGroupRange, meetingLabel } from "@/features/meetings/format";
import { groupMeetingsByDay } from "@/features/meetings/grouping";
import { useJustFinished } from "@/features/meetings/use-just-finished";
import type { MeetingsList } from "@/features/meetings/use-meetings";
import { notify } from "@/lib/toast";

export function MeetingList({
  list,
  searching,
  onClearSearch,
  onboarding,
}: {
  list: MeetingsList;
  /** True while a search term is active, which changes what "no meetings" means. */
  searching: boolean;
  onClearSearch: () => void;
  /** First-run empty state; only shown when the list itself is empty, never for a search. */
  onboarding: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [pending, setPending] = React.useState<Meeting | null>(null);
  const justFinished = useJustFinished(list.meetings);
  // Grouped once per render against a single "now", so two rows on opposite sides of midnight
  // cannot be measured against two different clocks within the same list.
  const groups = React.useMemo(() => groupMeetingsByDay(list.meetings), [list.meetings]);

  if (list.status === "loading") return <MeetingListSkeleton />;
  if (list.status === "error") return <LoadError code={list.errorCode} onRetry={list.reload} />;

  // An empty search result is not the flagship empty state: the user is looking for something
  // specific, so the answer is a calm note and a way out, with no illustration and no
  // encouragement (COMPONENTS.md §5).
  if (list.meetings.length === 0 && searching) {
    return (
      <Card className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="text-muted-foreground">{t("meetings.search.noResults")}</p>
        <Button variant="ghost" onClick={onClearSearch}>
          {t("meetings.search.clear")}
        </Button>
      </Card>
    );
  }

  if (list.meetings.length === 0) return <>{onboarding}</>;

  const confirmDelete = (): void => {
    if (!pending) return;
    const meetingId = pending.id;
    const label = meetingLabel(pending, i18n.language, t("meetings.untitled"));
    setPending(null);
    // The row is only removed once the server confirms the cascade, so the outcome arrives well
    // after the dialog closes. Until now the list expressed it by the row quietly disappearing,
    // which reads the same as a row scrolling away; the toast says which meeting is gone.
    void list
      .remove(meetingId)
      .then(() => notify.success(t("meetings.deleted", { meeting: label })))
      .catch(() => notify.failure(t("meetings.deleteFailed", { meeting: label })));
  };

  return (
    <>
      <div className="flex flex-col gap-[22px]">
        {groups.map((bucket) => (
          <section key={bucket.id} className="flex flex-col gap-2" aria-labelledby={bucket.id}>
            <h2
              id={bucket.id}
              // `font-sans` on purpose: this is a heading element for the sake of the document
              // outline, not a display line. At 12px, letter-spaced and uppercase, the display
              // face reads as a wordmark rather than as a quiet label.
              className="px-0.5 pt-1.5 font-sans text-section-label uppercase text-muted-foreground"
            >
              {bucket.group.kind === "week" || bucket.group.kind === "month"
                ? formatGroupRange(bucket.group, i18n.language)
                : t(`meetings.groups.${bucket.group.kind}`)}
            </h2>
            {/* One panel per bucket with hairlines between the rows, instead of a card per
                meeting: the stretch of time is the object with an edge, the meetings are its
                lines. */}
            <ul className="overflow-hidden rounded-card border border-border bg-card">
              {bucket.meetings.map((meeting, index) => (
                <li key={meeting.id} className="border-b border-border last:border-b-0">
                  <MeetingListItem
                    meeting={meeting}
                    groupKind={bucket.group.kind}
                    index={index}
                    deleting={list.deleting.has(meeting.id)}
                    justFinished={justFinished.has(meeting.id)}
                    onDelete={() => setPending(meeting)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <DeleteMeetingDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        meetingLabel={pending ? meetingLabel(pending, i18n.language, t("meetings.untitled")) : ""}
        onConfirm={confirmDelete}
      />
    </>
  );
}

/** Placeholder rows that mirror the real row geometry, so nothing jumps on arrival. */
function MeetingListSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" role="status" aria-label={t("common.loading")}>
      <Skeleton className="h-3 w-20" />
      <div className="overflow-hidden rounded-card border border-border bg-card">
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="flex items-center gap-3.5 border-b border-border px-4 py-[15px] last:border-b-0 md:px-[18px]"
          >
            <Skeleton className="h-3 w-[74px] shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadError({ code, onRetry }: { code: string | null; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p className="text-destructive">{t("meetings.loadError")}</p>
      {code ? <p className="font-mono text-xs text-muted-foreground">{code}</p> : null}
      <Button variant="outline" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </Card>
  );
}

/** The first-run state, which doubles as onboarding (COMPONENTS.md §12). */
export function MeetingsOnboarding({ children }: { children?: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <EmptyState icon={Mic} title={t("meetings.empty.title")} body={t("meetings.empty.body")}>
      <Button size="lg" onClick={() => void navigate("/record")}>
        <Mic aria-hidden="true" />
        {t("meetings.empty.action")}
      </Button>
      {children}
    </EmptyState>
  );
}
