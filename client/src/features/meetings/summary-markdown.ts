import type { Summary, SummarySection } from "@quorum/shared";

/**
 * Markdown rendering for the copy actions.
 *
 * Markdown rather than the styled HTML on screen: what people do with a summary is paste it into
 * a ticket, a wiki or a chat message, and those all read Markdown while none of them want our
 * CSS.
 */
export function sectionToMarkdown(section: SummarySection): string {
  const body = renderContent(section);
  return `## ${section.title}\n\n${body}`;
}

export function summaryToMarkdown(summary: Summary): string {
  return summary.sections.map(sectionToMarkdown).join("\n\n");
}

function renderContent(section: SummarySection): string {
  switch (section.format) {
    case "bullets":
      return section.content.map((line) => `- ${line}`).join("\n");
    case "table":
      // The table format stores one row per entry; without a column contract the honest
      // rendering is one row per line rather than a table shape we would be inventing.
      return section.content.join("\n");
    case "prose":
      return section.content.join("\n\n");
  }
}
