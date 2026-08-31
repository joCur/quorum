import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Summary, SummarySection } from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sectionToMarkdown, summaryToMarkdown } from "@/features/meetings/summary-markdown";

/**
 * The generated summary, rendered in the order of the template snapshot stored with it
 * (ADR-004 §2) — never the current template, so an old summary keeps explaining itself.
 */
export function SummaryView({
  summary,
  templateName,
}: {
  summary: Summary;
  /**
   * Name of the template behind the snapshot, resolved by the caller from the template list.
   *
   * It is not part of the snapshot itself — the snapshot stores what the summary was *produced
   * with*, and a name is a label people change freely. Null when the template has since been
   * deleted or renamed out of the list, in which case the header simply says nothing rather than
   * naming something that no longer exists. The version and model in the footer are the parts
   * that always hold.
   */
  templateName?: string | null;
}) {
  const { t, i18n } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        {templateName ? (
          <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            {/* Transitional: `plum` no longer exists in v2 and resolves to honey through the
                Tailwind color mapping. This marker becomes a honey underline when the
                meeting-detail area ticket restyles this screen. */}
            <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full bg-plum" />
            <span className="truncate">
              {t("meeting.summary.madeWith", { template: templateName })}
            </span>
          </p>
        ) : (
          <span />
        )}
        <CopyButton text={() => summaryToMarkdown(summary)} label={t("meeting.summary.copyAll")} />
      </div>

      {summary.sections.map((section, index) => (
        <Card
          key={section.sectionId}
          className="animate-rise-in"
          style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
        >
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="flex items-center gap-2">
              <span aria-hidden="true" className="h-5 w-1 rounded-full bg-plum" />
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

      <p className="text-xs text-muted-foreground">
        {t("meeting.summary.meta", {
          version: summary.templateSnapshot.templateVersion,
          model: summary.model,
          date: new Date(summary.createdAt).toLocaleString(i18n.language),
        })}
      </p>
    </div>
  );
}

function SectionContent({ section }: { section: SummarySection }) {
  if (section.format === "bullets") {
    return (
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-base leading-relaxed">
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
    <div className="flex max-w-[65ch] flex-col gap-3 text-base leading-relaxed">
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
