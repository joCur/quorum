import {
  SUMMARY_SCHEMA_VERSION,
  SummarySchema,
  type Summary,
  type SummaryOptions,
  type SummarySection,
  type TemplateSection,
} from "@quorum/shared";
import { JobError } from "../errors.js";
import { summaryIdForJob } from "../ids.js";

export interface SummaryMappingInput {
  /** Drives the deterministic summary id. */
  jobId: string;
  meetingId: string;
  /** The transcript this summary is derived from (1:n, ADR-004 §3). */
  transcriptId: string;
  templateId: string;
  templateVersion: number;
  /** The resolved sections — snapshot and prompt come from the same list. */
  resolvedSections: TemplateSection[];
  options: SummaryOptions;
  sections: SummarySection[];
  /** The model that answered, as the backend reported it, else the configured name. */
  model: string;
  promptVersion: string;
  createdAt: string;
  /**
   * The meeting name the model suggested, normalized, or null when it offered none. Recorded
   * whether or not the meeting adopts it — the document says what the model produced.
   */
  generatedTitle: string | null;
}

/**
 * Assembles the `Summary` of ADR-004.
 *
 * The snapshot is the point of this function: the resolved sections and the
 * options are copied in whole, next to the model and prompt version. A template
 * edited tomorrow cannot retroactively change what this summary claims to have
 * been generated from (ADR-004 §2), and the model/prompt pair makes a provider
 * switch auditable (ADR-005 §3).
 *
 * `isActive` is set here, but the "one active summary per template and meeting"
 * rule is enforced by a partial unique index in the database rather than by this
 * flag — see `db/schema.ts`.
 */
export function mapToSummary(input: SummaryMappingInput): Summary {
  const candidate = {
    id: summaryIdForJob(input.jobId),
    meetingId: input.meetingId,
    transcriptId: input.transcriptId,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    isActive: true,
    templateSnapshot: {
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      resolvedSections: input.resolvedSections,
      options: input.options,
    },
    model: input.model,
    promptVersion: input.promptVersion,
    generatedTitle: input.generatedTitle,
    createdAt: input.createdAt,
    sections: input.sections,
  };

  const parsed = SummarySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new JobError("SUMMARY_INVALID", `mapped summary is invalid: ${parsed.error.message}`, {
      retryable: false,
    });
  }
  return parsed.data;
}
