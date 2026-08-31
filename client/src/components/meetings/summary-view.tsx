import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Summary, SummarySection } from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeTime } from "@/features/meetings/format";
import { sectionToMarkdown, summaryToMarkdown } from "@/features/meetings/summary-markdown";

/**
 * The generated summary, rendered in the order of the template snapshot stored with it
 * (ADR-004 §2) — never the current template, so an old summary keeps explaining itself.
 */
export function SummaryView({ summary }: { summary: Summary }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3.5">
      {/* The whole-summary copy sits alone above the sections: the provenance line that used to
          share this row now lives at the foot of the rail, with the control that acts on it. */}
      <div className="flex justify-end">
        <CopyButton text={() => summaryToMarkdown(summary)} label={t("meeting.summary.copyAll")} />
      </div>

      {summary.sections.map((section, index) => (
        <Card
          key={section.sectionId}
          className="animate-rise-in rounded-card"
          style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
        >
          <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
            {/*
              The section title is underlined with honey rather than flagged with a marker beside
              it: an inset shadow sits behind the words themselves, so the accent is the width of
              the title and belongs to it, at any length and on either theme.
            */}
            <CardTitle className="w-fit font-display text-base font-bold leading-6 shadow-[inset_0_-0.32em_hsl(var(--honey)/0.4)]">
              {section.title}
            </CardTitle>
            <CopyButton
              text={() => sectionToMarkdown(section)}
              label={t("meeting.summary.copySection", { section: section.title })}
            />
          </CardHeader>
          <CardContent>
            <SectionContent section={section} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * One line saying where this summary came from: the template it was made with, the version of
 * that template, and how long ago it was written.
 *
 * It sits at the foot of the rail rather than above the sections, directly over the picker that
 * can replace it — the three facts and the control that acts on them read as one thing. The
 * relative time is what makes the line worth reading after a regenerate: the question it answers
 * is "is this the new one yet", and an absolute timestamp answers that slowly.
 */
export function SummaryAttribution({
  summary,
  templateName,
}: {
  summary: Summary;
  /**
   * Name of the template behind the snapshot, resolved by the caller from the template list.
   *
   * It is not part of the snapshot itself — the snapshot stores what the summary was *produced
   * with*, and a name is a label people change freely. Null when the template has since been
   * deleted or renamed out of the list, in which case the line drops that clause rather than
   * naming something that no longer exists. The version and the time always hold.
   */
  templateName?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const values = {
    template: templateName,
    version: summary.templateSnapshot.templateVersion,
    time: formatRelativeTime(summary.createdAt, i18n.language),
  };

  return (
    <p className="text-xs text-muted-foreground">
      {templateName
        ? t("meeting.summary.attribution", values)
        : t("meeting.summary.attributionNoTemplate", values)}
    </p>
  );
}

function SectionContent({ section }: { section: SummarySection }) {
  if (section.format === "bullets") {
    return (
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed">
        {section.content.map((line, index) => (
          <li key={`${section.sectionId}-${String(index)}`}>{line}</li>
        ))}
      </ul>
    );
  }

  if (section.format === "table") {
    // One row per entry, with no column contract to split on — inventing one would be the model
    // guessing on the user's behalf.
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <tbody>
            {section.content.map((row, index) => (
              <tr key={`${section.sectionId}-${String(index)}`} className="border-b border-border">
                <td className="py-2 pr-4 align-top">{row}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="flex max-w-[65ch] flex-col gap-3 text-sm leading-relaxed">
      {section.content.map((paragraph, index) => (
        <p key={`${section.sectionId}-${String(index)}`}>{paragraph}</p>
      ))}
    </div>
  );
}

/** Copy control that confirms on itself rather than through a toast. */
function CopyButton({ text, label }: { text: () => string; label: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          .writeText(text())
          .then(() => setCopied(true))
          // A clipboard the browser refuses is not worth an error dialog: the check simply
          // never appears, and the user can still select the text.
          .catch(() => setCopied(false));
      }}
    >
      {copied ? (
        <Check aria-hidden="true" className="animate-pop-in text-success" />
      ) : (
        <Copy aria-hidden="true" />
      )}
    </Button>
  );
}
