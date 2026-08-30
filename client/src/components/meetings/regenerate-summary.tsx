import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SummaryTemplateView } from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export interface RegenerateSummaryProps {
  templates: readonly SummaryTemplateView[];
  /** Template currently chosen — it decides which summary is shown and which one is rewritten. */
  templateId: string;
  onTemplateChange: (templateId: string) => void;
  pending: boolean;
  onRegenerate: (templateId: string) => void;
}

/**
 * Template picker plus the "Regenerate" action of the summary header (COMPONENTS.md §11).
 *
 * The picker does double duty, because a meeting keeps one summary per template (ADR-004 §3):
 * it chooses which of them is on screen, and it chooses which one the regenerate rewrites. One
 * control for one question — "which template?" — instead of two that could disagree.
 *
 * No confirmation dialog: regenerating destroys nothing. The previous summary stays on screen
 * until its replacement exists, and every summary carries the snapshot of the template it was
 * made with, so nothing about the old one becomes unexplainable (ADR-004 §2).
 */
export function RegenerateSummary({
  templates,
  templateId,
  onTemplateChange,
  pending,
  onRegenerate,
}: RegenerateSummaryProps) {
  const { t } = useTranslation();

  // Nothing to pick from and nothing to regenerate with: the control would be a dead button.
  if (templates.length === 0) return null;

  return (
    <div className="flex flex-wrap items-end justify-end gap-2">
      <div className="flex min-w-[12rem] flex-col gap-2">
        <Label htmlFor="regenerate-template">{t("meeting.summary.template")}</Label>
        <Select
          id="regenerate-template"
          value={templateId}
          onChange={(event) => onTemplateChange(event.target.value)}
        >
          {templates.map((view) => (
            <option key={view.template.id} value={view.template.id}>
              {view.template.name}
            </option>
          ))}
        </Select>
      </div>
      <Button
        variant="outline"
        disabled={pending || templateId === ""}
        onClick={() => onRegenerate(templateId)}
      >
        <RefreshCw aria-hidden="true" className={pending ? "animate-spin" : undefined} />
        {pending ? t("meeting.summary.regenerating") : t("meeting.summary.regenerate")}
      </Button>
    </div>
  );
}
