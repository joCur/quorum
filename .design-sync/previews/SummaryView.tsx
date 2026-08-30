import { SummaryView } from "@quorum/client";
import type { Summary, TemplateSection } from "@quorum/shared";

const resolvedSections: TemplateSection[] = [
  {
    id: "overview",
    title: "Overview",
    instruction: "Summarize what the meeting was about and how it concluded.",
    format: "prose",
  },
  {
    id: "decisions",
    title: "Decisions",
    instruction: "List every decision that was actually settled.",
    format: "bullets",
  },
  {
    id: "action-items",
    title: "Action Items",
    instruction: "List each task with its owner and due date.",
    format: "table",
  },
  {
    id: "open-questions",
    title: "Open Questions",
    instruction: "List what was raised but left unresolved.",
    format: "bullets",
  },
];

const summary: Summary = {
  id: "d3c81f57-2b40-4e69-a815-7c0d92fb6a34",
  meetingId: "0f2a7c1e-6b3d-4f81-9a52-1c8e4b7d0a31",
  transcriptId: "4b7a1e36-c920-4d58-8137-e6a05f2b94c1",
  schemaVersion: 1,
  isActive: true,
  templateSnapshot: {
    templateId: "aa7f0e91-58c6-4d32-b704-1e69a2c5d803",
    templateVersion: 3,
    resolvedSections,
    options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
  },
  model: "claude-sonnet-4-6",
  promptVersion: "summary-2026-07",
  createdAt: "2026-08-27T09:49:14.000Z",
  sections: [
    {
      sectionId: "overview",
      title: "Overview",
      format: "prose",
      content: [
        "The weekly product sync covered the onboarding funnel, the CSV export backlog, and two items carried over from the previous week. Most of the hour went to the funnel, where the workspace-creation step continues to lose about a third of new accounts.",
        "The team agreed to test collapsing that step into the first screen with a default workspace name, kept behind a flag so it can be reverted without a deploy. Export timeouts were acknowledged as the next priority once the funnel experiment is running.",
      ],
      sourceSegmentIds: null,
    },
    {
      sectionId: "decisions",
      title: "Decisions",
      format: "bullets",
      content: [
        "Merge the workspace-creation step into the first onboarding screen, with a generated default name.",
        "Ship the change behind a feature flag and compare completion rates over one week.",
        "Keep the previous step in the code path so a rollback needs no deploy.",
      ],
      sourceSegmentIds: null,
    },
    {
      sectionId: "action-items",
      title: "Action Items",
      format: "table",
      content: [
        "Tomás Rivera — instrument the flagged onboarding variant — by Sep 2",
        "Priya Nandan — draft the default workspace naming rules — by Sep 1",
        "Maya Ellis — review the four open export tickets with support — by Sep 4",
      ],
      sourceSegmentIds: null,
    },
    {
      sectionId: "open-questions",
      title: "Open Questions",
      format: "bullets",
      content: [
        "Does the default workspace name need to be unique per account, or is a collision acceptable?",
        "Should the export job be chunked, or moved to an off-peak schedule for the largest accounts?",
      ],
      sourceSegmentIds: null,
    },
  ],
};

const frame: React.CSSProperties = { maxWidth: 720 };

/** One card per cell: the review sheet clips a cell, and a whole summary is taller than one. */
const only = (...ids: string[]): Summary => ({
  ...summary,
  sections: summary.sections.filter((section) => ids.includes(section.sectionId)),
});

export function ProseSection() {
  return (
    <div style={frame}>
      <SummaryView summary={only("overview")} />
    </div>
  );
}

export function BulletSections() {
  return (
    <div style={frame}>
      <SummaryView summary={only("decisions", "open-questions")} />
    </div>
  );
}

export function TableSection() {
  return (
    <div style={frame}>
      <SummaryView summary={only("action-items")} />
    </div>
  );
}
