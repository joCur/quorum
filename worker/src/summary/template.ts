import {
  SUMMARY_SCHEMA_VERSION,
  SummaryTemplateSchema,
  type SummaryTemplate,
  type TemplateSection,
} from "@quorum/shared";
import { JobError } from "../errors.js";

/**
 * The system default summary template (ADR-004 §1).
 *
 * Its id is a fixed constant rather than a generated one: the worker seeds this
 * row on start, the enqueue path names it as the default, and a summary's
 * snapshot has to keep pointing at something recognizable years later.
 *
 * `version` is the contract for change. Editing a section's instruction is a
 * new version, never an in-place edit — old summaries keep the wording they
 * were actually produced with, because the snapshot copied it (ADR-004 §2).
 *
 * Section titles are stored data, not UI chrome, so they are not routed through
 * i18n: they travel inside the immutable snapshot and must read the same when
 * the summary is opened again. The section *ids* are stable, so a client that
 * wants localized headings maps them by id; `options.outputLanguage` controls
 * the language of the generated content itself.
 */
export const SYSTEM_TEMPLATE_ID = "0b7a1f4d-2c3e-4a55-9f61-8d5c4a2b7e10";

/**
 * Bumped whenever the prompt scaffolding around the template changes, even if
 * no template text does. Stored per summary next to the model name so a change
 * in output quality can be attributed (ADR-005 §3).
 */
export const PROMPT_VERSION = "summary-prompt-1";

const SYSTEM_TEMPLATE_SECTIONS: readonly TemplateSection[] = [
  {
    id: "overview",
    title: "Overview",
    instruction:
      "Summarize what this meeting was about and what it achieved, in three to five sentences. " +
      "Name the participants only if the transcript identifies them. Do not list decisions or " +
      "tasks here — they have their own sections.",
    format: "prose",
  },
  {
    id: "key-points",
    title: "Key Points",
    instruction:
      "The substantive points discussed, one per bullet, in the order they came up. Include the " +
      "reasoning or trade-off behind a point where the transcript gives it. Skip small talk, " +
      "scheduling chatter and repetition.",
    format: "bullets",
  },
  {
    id: "decisions",
    title: "Decisions",
    instruction:
      "Every decision the meeting actually settled, one per bullet, phrased as the decision and " +
      "its rationale. A topic that was merely discussed is not a decision — leave it out. If " +
      "nothing was decided, return an empty list rather than inventing one.",
    format: "bullets",
  },
  {
    id: "action-items",
    title: "Action Items",
    instruction:
      'Concrete tasks somebody committed to. One row per task with the keys "task", "owner" ' +
      'and "due". Use null for an owner or due date the transcript does not state — never guess ' +
      "a name or a date.",
    format: "table",
  },
  {
    id: "open-questions",
    title: "Open Questions",
    instruction:
      "Questions that were raised and left unanswered, and points explicitly deferred to a later " +
      "meeting. One per bullet. Return an empty list if everything raised was resolved.",
    format: "bullets",
  },
];

/** Column order for `table` sections of the system template. */
export const ACTION_ITEM_COLUMNS = ["task", "owner", "due"] as const;

export const SYSTEM_SUMMARY_TEMPLATE: SummaryTemplate = SummaryTemplateSchema.parse({
  id: SYSTEM_TEMPLATE_ID,
  schemaVersion: SUMMARY_SCHEMA_VERSION,
  name: "Standard meeting summary",
  version: 1,
  scope: "system",
  basedOn: null,
  sections: SYSTEM_TEMPLATE_SECTIONS,
  overrides: [],
  options: {},
});

/**
 * Applies a template's overrides to its sections (ADR-004 §1: exactly one level
 * of inheritance, so this runs over an already-merged section list).
 *
 * - `add` appends a section that is not there yet; if the id already exists it
 *   behaves like `replace`, because two sections with one id would be ambiguous
 *   downstream.
 * - `replace` swaps a section in place, keeping its position so the reading
 *   order of the base template survives.
 * - `hide` removes it.
 *
 * The result is what gets snapshotted, and it is what the prompt is built from —
 * the same list, so the model can never be asked for a section the snapshot does
 * not describe.
 */
export function resolveTemplateSections(template: SummaryTemplate): TemplateSection[] {
  const resolved: TemplateSection[] = [...template.sections];

  for (const override of template.overrides) {
    const index = resolved.findIndex((section) => section.id === override.sectionId);

    if (override.action === "hide") {
      if (index >= 0) resolved.splice(index, 1);
      continue;
    }

    const section = override.section;
    if (!section) {
      throw new JobError(
        "SUMMARY_TEMPLATE_NOT_FOUND",
        `override "${override.action}" for section "${override.sectionId}" carries no section`,
        { retryable: false },
      );
    }
    if (index >= 0) resolved.splice(index, 1, section);
    else resolved.push(section);
  }

  if (resolved.length === 0) {
    throw new JobError(
      "SUMMARY_TEMPLATE_NOT_FOUND",
      `template ${template.id} resolves to no sections`,
      { retryable: false },
    );
  }
  return resolved;
}
