import * as React from "react";
import { FileText, Mic, ScrollText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RecoveryCard } from "@/components/recording/recovery-card";
import { IconTile } from "@/components/layout/icon-tile";
import { MeetingList, MeetingsOnboarding } from "@/components/meetings/meeting-list";
import { MeetingSearch } from "@/components/meetings/meeting-search";
import { useMeetings } from "@/features/meetings/use-meetings";

/**
 * Meetings screen — the app's front door.
 *
 * The search field appears only once there is something to search: on a first run it would be a
 * control with nothing to act on, and the empty state is meant to be an invitation rather than a
 * form (STATES.md §9, the same rule applied to controls).
 */
export function MeetingsRoute() {
  const { t } = useTranslation();
  const [search, setSearch] = React.useState("");
  const list = useMeetings(search);

  const showSearch = list.status === "ready" && (list.meetings.length > 0 || search !== "");

  return (
    <div className="flex flex-col gap-6">
      {/* The search sits beside the heading rather than in a band under it: a full-width field
          reads as the screen's subject, and the meetings are. It wraps below the heading when
          the two no longer fit side by side. */}
      <div className="flex flex-wrap items-baseline justify-between gap-3.5">
        <h1 className="text-xl font-bold md:text-2xl">{t("meetings.title")}</h1>
        {showSearch ? <MeetingSearch value={search} onChange={setSearch} /> : null}
      </div>
      <RecoveryCard />
      <MeetingList
        list={list}
        searching={search.trim() !== ""}
        onClearSearch={() => setSearch("")}
        onboarding={
          <MeetingsOnboarding>
            <HowItWorksSheet />
          </MeetingsOnboarding>
        }
      />
    </div>
  );
}

const STEPS: readonly { key: "record" | "transcribe" | "summarize"; icon: LucideIcon }[] = [
  { key: "record", icon: Mic },
  { key: "transcribe", icon: FileText },
  { key: "summarize", icon: ScrollText },
];

/** Three-step explainer; a bottom sheet on mobile, a dialog from `md` up. */
function HowItWorksSheet() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          {t("meetings.empty.howItWorks")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("common.close")}>
        <DialogTitle>{t("howItWorks.title")}</DialogTitle>
        <DialogDescription>{t("howItWorks.intro")}</DialogDescription>
        <ol className="flex flex-col gap-4">
          {STEPS.map((step, index) => (
            <li key={step.key} className="flex items-start gap-4">
              <IconTile
                icon={step.icon}
                // Transitional: `plum` no longer exists in v2 and resolves to honey through the
                // Tailwind color mapping. The section marker becomes a honey underline when the
                // meetings-list area ticket restyles this screen.
                accent={step.key === "summarize" ? "plum" : "honey"}
                size="sm"
              />
              <div className="flex flex-col gap-1 text-left">
                <span className="text-lg font-semibold">
                  {index + 1}. {t(`howItWorks.steps.${step.key}.title`)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`howItWorks.steps.${step.key}.body`)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
