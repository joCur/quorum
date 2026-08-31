import { z } from "zod";

/**
 * Summary templates and summaries (ADR-004)
 * A system template as the default, user templates with one level of inheritance,
 * and a snapshot of the resolved configuration per generated summary.
 */

export const SUMMARY_SCHEMA_VERSION = 1;

export const SectionFormatSchema = z.enum(["prose", "bullets", "table"]);

export const TemplateSectionSchema = z.object({
  id: z.string(),
  title: z.string(), // e.g. "Decisions", "Action Items", "Open Questions"
  /** A prompt building block: what belongs in this section */
  instruction: z.string(),
  format: SectionFormatSchema,
});

/** An override in user templates: add, change or hide a section */
export const SectionOverrideSchema = z.object({
  sectionId: z.string(),
  action: z.enum(["add", "replace", "hide"]),
  /** Bei add/replace erforderlich */
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
  scope: z.enum(["system", "user"]), // extensible later: team/org
  /** Only one level of inheritance: a user template basedOn a system template */
  basedOn: z.string().uuid().nullable().default(null),
  sections: z.array(TemplateSectionSchema).default([]),
  overrides: z.array(SectionOverrideSchema).default([]),
  options: SummaryOptionsSchema.default({}),
});

// ---- Erzeugte Summary ----

export const SummarySectionSchema = z.object({
  sectionId: z.string(),
  title: z.string(),
  format: SectionFormatSchema,
  /** Strukturierter Inhalt: prose = 1 Element, bullets = n Elemente, table = Zeilen als JSON */
  content: z.array(z.string()),
  /** Quellenverweise auf Transcript-Segmente (ADR-003 stabile IDs); V1: null */
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
  /** Womit erzeugt — analog model/modelVersion im Transcript */
  model: z.string(),
  promptVersion: z.string(),
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
