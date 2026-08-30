import { z } from "zod";
import { JobSchema } from "./job.js";
import {
  SectionOverrideSchema,
  SummaryOptionsSchema,
  SummaryTemplateSchema,
  TemplateSectionSchema,
} from "./summary.js";

/**
 * HTTP contracts for user summary templates and for re-running a summary
 * (ADR-004). Kept next to the domain schemas so client and server import the
 * same definitions instead of describing the API twice.
 */

/** Upper bound on a template name; long enough for a sentence, short enough to render in a list. */
export const MAX_TEMPLATE_NAME_LENGTH = 120;

/**
 * Cap on the sections one template may carry. Each section costs prompt budget
 * and one more thing for the model to fill; a template with fifty of them would
 * quietly degrade every summary made with it.
 */
export const MAX_TEMPLATE_SECTIONS = 20;

/**
 * What a client sends to create or update a user template.
 *
 * `id`, `version` and `scope` are deliberately absent: the server assigns the
 * id, bumps the version (a template change is a new version, never an in-place
 * edit — ADR-004 §2) and only ever writes `user` scope through this endpoint.
 */
export const SummaryTemplateDraftSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TEMPLATE_NAME_LENGTH),
  /** Template this one inherits from; the server defaults it to the system template. */
  basedOn: z.string().uuid().nullable().optional(),
  /** Only meaningful for a template without `basedOn`; an inheriting one speaks in overrides. */
  sections: z.array(TemplateSectionSchema).max(MAX_TEMPLATE_SECTIONS).default([]),
  overrides: z
    .array(SectionOverrideSchema)
    .max(MAX_TEMPLATE_SECTIONS * 2)
    .default([]),
  options: SummaryOptionsSchema.default({}),
});

/**
 * A template as the API returns it: the stored document plus the resolved
 * section list, so a client can render or preview it without reimplementing
 * inheritance, and a flag saying whether this caller may edit it.
 */
export const SummaryTemplateViewSchema = z.object({
  template: SummaryTemplateSchema,
  /** `sections` and `overrides` applied against the base — what a summary would use. */
  resolvedSections: z.array(TemplateSectionSchema),
  /** False for the system template: it is everybody's, so nobody edits it here. */
  editable: z.boolean(),
});

export const SummaryTemplateListSchema = z.object({
  templates: z.array(SummaryTemplateViewSchema),
});

/**
 * Request to produce a summary of a meeting again — the "Regenerate" action.
 *
 * Both fields are optional and both default to the obvious thing: the system
 * template, and the meeting's active transcript. Naming the transcript
 * explicitly matters because meeting → transcript is 1:n (ADR-003 §3).
 */
export const RegenerateSummaryRequestSchema = z.object({
  templateId: z.string().uuid().optional(),
  transcriptId: z.string().uuid().optional(),
});

/**
 * Answer to an accepted regenerate request: the queued job, so the caller can
 * show that work has started and follow it in the meeting's job list.
 */
export const SummaryJobAcceptedSchema = z.object({
  job: JobSchema,
  templateId: z.string().uuid(),
  transcriptId: z.string().uuid(),
});

export type SummaryTemplateDraft = z.infer<typeof SummaryTemplateDraftSchema>;
export type SummaryTemplateView = z.infer<typeof SummaryTemplateViewSchema>;
export type SummaryTemplateList = z.infer<typeof SummaryTemplateListSchema>;
export type RegenerateSummaryRequest = z.infer<typeof RegenerateSummaryRequestSchema>;
export type SummaryJobAccepted = z.infer<typeof SummaryJobAcceptedSchema>;
