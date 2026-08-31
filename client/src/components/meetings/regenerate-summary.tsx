import { useTranslation } from "react-i18next";
import type { SummaryTemplateView } from "@quorum/shared";
import { Button } from "@/components/ui/button";
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
    // Two pills on one line. The picker carries its name as a label rather than showing one: in a
    // rail this narrow, a stacked caption and field spend three rows asking one small question,
    // and the value on the control already answers it.
    <div className="flex flex-wrap items-center gap-2">
      <Select
        id="regenerate-template"
        aria-label={t("meeting.summary.template")}
        value={templateId}
        onChange={(event) => onTemplateChange(event.target.value)}
        className="h-9 w-auto rounded-pill border-border bg-card px-3 pr-8 text-[13px]"
      >
        {templates.map((view) => (
          <option key={view.template.id} value={view.template.id}>
            {view.template.name}
          </option>
        ))}
      </Select>
      {/*
        Work in progress is said in the label and nowhere else: a spinning icon would be a second,
        louder voice for the same fact, and the summary above already dims while its replacement
        is being written.
      */}
      <Button
        variant="outline"
        size="sm"
        disabled={pending || templateId === ""}
        onClick={() => onRegenerate(templateId)}
        className="rounded-pill border-border bg-card px-[18px] text-[13px] font-bold"
      >
        {pending ? t("meeting.summary.regenerating") : t("meeting.summary.regenerate")}
      </Button>
    </div>
  );
}
