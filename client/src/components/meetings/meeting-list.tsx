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
import { meetingLabel } from "@/features/meetings/format";
import type { MeetingsList } from "@/features/meetings/use-meetings";

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
    setPending(null);
    void list.remove(meetingId);
  };

  return (
    <>
      <ul className="flex flex-col gap-2">
        {list.meetings.map((meeting, index) => (
          <li key={meeting.id}>
            <MeetingListItem
              meeting={meeting}
              index={index}
              deleting={list.deleting.has(meeting.id)}
              onDelete={() => setPending(meeting)}
            />
          </li>
        ))}
      </ul>

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
      {[0, 1, 2, 3].map((row) => (
        <Card key={row} className="flex items-center gap-3 p-3 md:p-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-6 w-24 rounded-full" />
        </Card>
      ))}
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
