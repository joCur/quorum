import * as React from "react";
import { FileText, Mic, ScrollText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/layout/empty-state";
import { RecoveryCard } from "@/components/recording/recovery-card";
import { IconTile } from "@/components/layout/icon-tile";

/**
 * Meetings screen — the app's front door.
 *
 * The list itself and meeting detail belong to their own ticket; what lives here
 * is the first-run state, which doubles as onboarding.
 */
export function MeetingsRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold md:text-2xl">{t("meetings.title")}</h1>
      <RecoveryCard />
      <EmptyState icon={Mic} title={t("meetings.empty.title")} body={t("meetings.empty.body")}>
        <Button size="lg" onClick={() => void navigate("/record")}>
          <Mic aria-hidden="true" />
          {t("meetings.empty.action")}
        </Button>
        <HowItWorksSheet />
      </EmptyState>
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
