import { z } from "zod";
import { MAX_GENERATED_TITLE_LENGTH } from "./meeting-title.js";

export const SUMMARY_SCHEMA_VERSION = 1;

export const SectionFormatSchema = z.enum(["prose", "bullets", "table"]);

export const TemplateSectionSchema = z.object({
  id: z.string(),
  title: z.string(), // e.g. "Decisions", "Action Items", "Open Questions"
  /** A prompt building block: what belongs in this section */
  instruction: z.string(),
  format: SectionFormatSchema,
});

export const SectionOverrideSchema = z.object({
  sectionId: z.string(),
  action: z.enum(["add", "replace", "hide"]),
  /** Required for `add` and `replace`, unused for `hide`. */
  section: TemplateSectionSchema.nullable().default(null),
});

export const SummaryOptionsSchema = z.object({
  tone: z.enum(["neutral", "formal", "casual"]).default("neutral"),
  length: z.enum(["brief", "standard", "detailed"]).default("standard"),
  outputLanguage: z.string().default("auto"), // "auto" | BCP-47
});

export const SummaryTemplateSchema = z.object({
  id: z.string().uuid(),
  schemaVersion: z.literal(SUMMARY_SCHEMA_VERSION),
  name: z.string(),
  /** Templates are versioned; a change produces a new version */
  version: z.number().int().positive(),
  scope: z.enum(["system", "user"]),
  /** Only one level of inheritance: a user template basedOn a system template */
  basedOn: z.string().uuid().nullable().default(null),
  sections: z.array(TemplateSectionSchema).default([]),
  overrides: z.array(SectionOverrideSchema).default([]),
  options: SummaryOptionsSchema.default({}),
});

export const SummarySectionSchema = z.object({
  sectionId: z.string(),
  title: z.string(),
  format: SectionFormatSchema,
  /** One entry for `prose`, one per bullet for `bullets`, one JSON-encoded row for `table`. */
  content: z.array(z.string()),
  /** References to transcript segments (ADR-003 stable ids); always null in V1. */
  sourceSegmentIds: z.array(z.string().uuid()).nullable().default(null),
});

export const SummarySchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  /** Which transcript (1:n!) this summary is based on */
  transcriptId: z.string().uuid(),
  schemaVersion: z.literal(SUMMARY_SCHEMA_VERSION),
  /** One active summary per template and meeting */
  isActive: z.boolean(),
  /** A SNAPSHOT of the resolved template configuration at generation time */
  templateSnapshot: z.object({
    templateId: z.string().uuid(),
    templateVersion: z.number().int().positive(),
    resolvedSections: z.array(TemplateSectionSchema),
    options: SummaryOptionsSchema,
  }),
  model: z.string(),
  promptVersion: z.string(),
  /**
   * A name for the meeting, produced from the same transcript as the sections.
   *
   * It is a suggestion and it is immutable, like every other part of this document: it records
   * what the model proposed, whether or not the meeting ended up carrying it. Whether the meeting
   * takes it is decided once, when the summary is stored, by `generatedTitleUpdate` — a title the
   * user wrote always wins. `null` when the model offered none, and on every summary produced
   * before titles were asked for.
   *
   * `.catch(null)` rather than a plain constraint: this field is the least important thing in the
   * document, and the readers parse the whole summary or drop it. A stored value that somehow
   * violates the bound has to cost the name, never the summary it belongs to.
   */
  generatedTitle: z
    .string()
    .min(1)
    .max(MAX_GENERATED_TITLE_LENGTH)
    .nullable()
    .default(null)
    .catch(null),
  createdAt: z.string().datetime(),
  sections: z.array(SummarySectionSchema),
});

export type SectionFormat = z.infer<typeof SectionFormatSchema>;
export type TemplateSection = z.infer<typeof TemplateSectionSchema>;
export type SectionOverride = z.infer<typeof SectionOverrideSchema>;
export type SummaryOptions = z.infer<typeof SummaryOptionsSchema>;
export type SummaryTemplate = z.infer<typeof SummaryTemplateSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type SummarySection = z.infer<typeof SummarySectionSchema>;
/** The resolved template configuration copied into every summary (ADR-004 §2). */
export type SummaryTemplateSnapshot = Summary["templateSnapshot"];
