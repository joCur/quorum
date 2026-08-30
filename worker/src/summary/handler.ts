import {
  resolveOutputLanguage,
  type Job,
  type SummaryOptions,
  type SummarySection,
  type SummaryTemplate,
  type Transcript,
} from "@quorum/shared";
import type { SummaryRepository } from "../db/repository.js";
import { logMeetingGone, type WorkerLogger } from "../logger.js";
import { JobError, MeetingGoneError, toJobError } from "../errors.js";
import { summaryIdForJob } from "../ids.js";
import type { SummarizeJobPayload } from "../payload.js";
import type { ChatCompletionClient, ChatMessage } from "./chat-client.js";
import { mapToSummary } from "./map.js";
import { parseSummaryResponse, SummaryParseError } from "./parse.js";
import { buildRepairMessages, buildSummaryMessages } from "./prompt.js";
import { PROMPT_VERSION, resolveTemplateSections } from "./template.js";
import { windowTranscript } from "./transcript-window.js";

export interface SummarizeHandlerDependencies {
  chat: ChatCompletionClient;
  repository: SummaryRepository;
  logger: WorkerLogger;
  /** Input budget for the transcript window; see `transcript-window.ts`. */
  maxInputTokens: number;
  now?: () => Date;
}

export interface SummarizeOutcome {
  summaryId: string;
  /** `false` when the job had already produced this summary. */
  created: boolean;
  sectionCount: number;
  /** `true` when the first answer was unparseable and the repair turn succeeded. */
  repaired: boolean;
  transcriptTruncated: boolean;
  /**
   * Set when the meeting was deleted while the job was running. Nothing was
   * written — not the summary and not a job row — and `summaryId` is only the
   * id the run would have used.
   */
  abandoned?: "meeting-deleted";
}

/**
 * Runs one `summarize` job end to end: transcript → template → prompt → LLM →
 * `Summary` → PostgreSQL.
 *
 * Every step is a port, so this function is testable without a database or an
 * HTTP backend. Failures leave a `failed` job row behind with the
 * machine-readable code from `errors.ts` before they are rethrown for the queue
 * to act on — same contract as the transcription handler.
 */
export async function runSummarizeJob(
  payload: SummarizeJobPayload,
  attempt: number,
  deps: SummarizeHandlerDependencies,
): Promise<SummarizeOutcome> {
  const now = deps.now ?? (() => new Date());
  const scope = {
    tenantId: payload.tenantId,
    userId: payload.userId,
    sessionId: payload.sessionId,
  };
  const log = deps.logger.child({
    jobId: payload.job.id,
    meetingId: payload.job.meetingId,
    sessionId: payload.sessionId,
    tenantId: payload.tenantId,
    userId: payload.userId,
    transcriptId: payload.transcriptId,
    templateId: payload.templateId,
    attempt,
  });

  const startedAt = now().toISOString();
  const running: Job = { ...payload.job, status: "running", startedAt, finishedAt: null };
  await deps.repository.saveJob(running, scope, attempt);
  log.info({ event: "job.started" }, "summary job started");

  try {
    const transcript = await loadTranscript(payload, deps);
    const template = await deps.repository.loadTemplate(payload.templateId, payload.tenantId);
    if (!template) {
      throw new JobError(
        "SUMMARY_TEMPLATE_NOT_FOUND",
        `template ${payload.templateId} is not available to tenant ${payload.tenantId}`,
        { retryable: false },
      );
    }

    // A user template inherits its sections from the template it is based on, and
    // it inherits them *as they are now* — that is the point of storing overrides
    // instead of a copy (ADR-004 §1). The base is loaded under the same tenant
    // predicate, so an inherited template can never pull in another tenant's rows.
    const base = await loadBaseTemplate(template, payload.tenantId, deps);
    const resolvedSections = resolveTemplateSections(template, base);
    const options = resolveOptions(template.options, transcript.language);
    if (options.outputLanguage !== template.options.outputLanguage) {
      log.info(
        {
          event: "summary.language.resolved",
          requested: template.options.outputLanguage,
          resolved: options.outputLanguage,
        },
        "output language followed the transcript",
      );
    }
    const window = windowTranscript(transcript, deps.maxInputTokens);
    if (window.includedSegments === 0) {
      throw new JobError(
        "TRANSCRIPT_EMPTY",
        `transcript ${transcript.id} contains no text to summarize`,
        { retryable: false },
      );
    }
    log.info(
      {
        event: "transcript.windowed",
        totalSegments: window.totalSegments,
        includedSegments: window.includedSegments,
        truncated: window.truncated,
        estimatedTokens: window.estimatedTokens,
        maxInputTokens: deps.maxInputTokens,
      },
      window.truncated
        ? "transcript exceeded the input budget; its middle was elided"
        : "transcript fits the input budget",
    );

    const messages = buildSummaryMessages({
      sections: resolvedSections,
      options,
      window,
      recordedAt: transcript.recordedAt,
    });

    const { sections, repaired, model } = await completeWithOneRepair(
      messages,
      resolvedSections,
      deps,
      log,
    );

    const summary = mapToSummary({
      jobId: payload.job.id,
      meetingId: payload.job.meetingId,
      transcriptId: transcript.id,
      templateId: template.id,
      templateVersion: template.version,
      resolvedSections,
      options,
      sections,
      model,
      promptVersion: PROMPT_VERSION,
      createdAt: now().toISOString(),
    });

    const saved = await deps.repository.saveSummary(summary, scope, payload.job.id);

    const succeeded: Job = {
      ...payload.job,
      status: "succeeded",
      progress: 1,
      error: null,
      resultId: saved.summaryId,
      startedAt,
      finishedAt: now().toISOString(),
    };
    await deps.repository.saveJob(succeeded, scope, attempt);
    log.info(
      {
        event: "job.succeeded",
        summaryId: saved.summaryId,
        created: saved.created,
        sectionCount: summary.sections.length,
        repaired,
        model,
      },
      saved.created ? "summary persisted" : "summary already existed; job replay was a no-op",
    );

    return {
      summaryId: saved.summaryId,
      created: saved.created,
      sectionCount: summary.sections.length,
      repaired,
      transcriptTruncated: window.truncated,
    };
  } catch (error) {
    if (error instanceof MeetingGoneError) {
      logMeetingGone(log, "summary");
      return {
        summaryId: summaryIdForJob(payload.job.id),
        created: false,
        sectionCount: 0,
        repaired: false,
        transcriptTruncated: false,
        abandoned: "meeting-deleted",
      };
    }
    const jobError = toJobError(error);
    const failed: Job = {
      ...payload.job,
      status: "failed",
      error: { code: jobError.code, message: jobError.message },
      startedAt,
      finishedAt: now().toISOString(),
    };
    // Best effort: if the database is the thing that broke, the queue still has
    // to learn about the failure.
    await deps.repository.saveJob(failed, scope, attempt).catch((persistError: unknown) => {
      log.error(
        { event: "job.state.persist_failed", err: persistError },
        "could not record failure",
      );
    });
    log.error(
      { event: "job.failed", code: jobError.code, retryable: jobError.retryable, err: jobError },
      "summary job failed",
    );
    throw jobError;
  }
}

/**
 * The template `basedOn` points at, or `null` when this template inherits from
 * nothing. Missing base is terminal: the sections it would contribute are not
 * going to appear on a retry, and producing a summary from the overrides alone
 * would silently drop everything the user expected to inherit.
 */
async function loadBaseTemplate(
  template: SummaryTemplate,
  tenantId: string,
  deps: SummarizeHandlerDependencies,
): Promise<SummaryTemplate | null> {
  if (template.basedOn === null) return null;
  const base = await deps.repository.loadTemplate(template.basedOn, tenantId);
  if (!base) {
    throw new JobError(
      "SUMMARY_TEMPLATE_NOT_FOUND",
      `template ${template.id} inherits from ${template.basedOn}, which is not available to tenant ${tenantId}`,
      { retryable: false },
    );
  }
  return base;
}

/**
 * The options the summary is actually produced with.
 *
 * Only `outputLanguage` is derived, and only when it is still `auto`: the stored
 * default means "follow the recording", and the transcript is the only place
 * that knows what the recording was in. Resolving it here rather than in the
 * prompt puts the concrete language into the snapshot, so an existing summary
 * can say which language it was asked for.
 */
function resolveOptions(options: SummaryOptions, transcriptLanguage: string): SummaryOptions {
  return {
    ...options,
    outputLanguage: resolveOutputLanguage(options.outputLanguage, transcriptLanguage),
  };
}

async function loadTranscript(
  payload: SummarizeJobPayload,
  deps: SummarizeHandlerDependencies,
): Promise<Transcript> {
  const transcript = await deps.repository.loadTranscript(payload.transcriptId, payload.tenantId);
  if (transcript) return transcript;

  // The transcript is gone. Which of the two reasons it is decides everything:
  // if the meeting was deleted, the cascade took the transcript with it and the
  // job is simply obsolete — abandoning it quietly is the whole point of this
  // check, and dead-lettering it would leave an operator a job to replay that
  // must never be replayed. Only a transcript missing while its meeting still
  // exists is a real, terminal fault worth reporting.
  if (!(await deps.repository.meetingExists(payload.job.meetingId, payload.tenantId))) {
    throw new MeetingGoneError(payload.job.meetingId);
  }
  throw new JobError(
    "TRANSCRIPT_NOT_FOUND",
    `transcript ${payload.transcriptId} not found for tenant ${payload.tenantId}`,
    { retryable: false },
  );
}

/**
 * One call, and if the answer cannot be parsed, exactly one repair turn.
 *
 * Why not more: every attempt is a paid call over the same transcript, and a
 * model that ignores the output contract twice in a row is not going to comply
 * on the third try — it is a prompt or model problem, and a human needs to see
 * it. Why not zero: a single stray sentence around otherwise perfect JSON is
 * the most common failure by far, and quoting the parser's own complaint back
 * fixes it almost every time.
 *
 * After the repair fails, the error is terminal (`SUMMARY_RESPONSE_INVALID`),
 * so the job dead-letters immediately instead of burning the retry budget on an
 * outcome that will not change. The failing answer is logged, truncated, as the
 * only evidence of what the model actually said.
 */
async function completeWithOneRepair(
  messages: ChatMessage[],
  resolvedSections: ReturnType<typeof resolveTemplateSections>,
  deps: SummarizeHandlerDependencies,
  log: WorkerLogger,
): Promise<{ sections: SummarySection[]; repaired: boolean; model: string }> {
  const first = await deps.chat.complete(messages);
  logCompletion(log, first, "summary.completed");

  try {
    const parsed = parseSummaryResponse(first.content, resolvedSections);
    warnAboutMissingSections(log, parsed.missingSectionIds);
    return { sections: parsed.sections, repaired: false, model: first.model ?? deps.chat.model };
  } catch (error) {
    if (!(error instanceof SummaryParseError)) throw error;
    log.warn(
      {
        event: "summary.output.malformed",
        problem: error.message,
        finishReason: first.finishReason,
        answerPreview: first.content.slice(0, 500),
      },
      "model answer could not be parsed; asking once for a repair",
    );

    const repair = await deps.chat.complete(
      buildRepairMessages(messages, first.content, error.message),
    );
    logCompletion(log, repair, "summary.repair.completed");

    try {
      const parsed = parseSummaryResponse(repair.content, resolvedSections);
      warnAboutMissingSections(log, parsed.missingSectionIds);
      log.info({ event: "summary.output.repaired" }, "repair attempt produced a usable answer");
      return { sections: parsed.sections, repaired: true, model: repair.model ?? deps.chat.model };
    } catch (repairError) {
      if (!(repairError instanceof SummaryParseError)) throw repairError;
      log.error(
        {
          event: "summary.output.unrecoverable",
          firstProblem: error.message,
          repairProblem: repairError.message,
          finishReason: repair.finishReason,
          answerPreview: repair.content.slice(0, 500),
        },
        "model did not produce a parseable summary after one repair attempt",
      );
      throw new JobError(
        "SUMMARY_RESPONSE_INVALID",
        `model output was unusable after a repair attempt: ${repairError.message}`,
        { retryable: false, cause: repairError },
      );
    }
  }
}

function warnAboutMissingSections(log: WorkerLogger, missingSectionIds: string[]): void {
  if (missingSectionIds.length === 0) return;
  // Not fatal: the snapshot still describes the section, it is simply empty.
  // Worth a line because a template whose sections are chronically skipped is a
  // prompt problem.
  log.warn(
    { event: "summary.sections.missing", missingSectionIds },
    "model omitted template sections; they are stored empty",
  );
}

function logCompletion(
  log: WorkerLogger,
  result: {
    promptTokens: number | null;
    completionTokens: number | null;
    finishReason: string | null;
    model: string | null;
  },
  event: string,
): void {
  if (result.finishReason === "length") {
    // The answer was cut off at max_tokens, which almost always means truncated
    // JSON. Logged separately because raising the output budget is the fix.
    log.warn(
      { event: "summary.output.truncated", model: result.model },
      "model stopped at the output token limit",
    );
  }
  log.info(
    {
      event,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      finishReason: result.finishReason,
    },
    "summary backend answered",
  );
}
