import { transcriptionLanguageRequest, type Job } from "@quorum/shared";
import type { AudioSource } from "./storage/audio-source.js";
import type { TranscriptionClient } from "./whisper/client.js";
import type { TranscriptRepository } from "./db/repository.js";
import type { WorkerLogger } from "./logger.js";
import { JobError, MeetingGoneError, toJobError } from "./errors.js";
import { transcriptIdForJob } from "./ids.js";
import { logMeetingGone } from "./logger.js";
import { audioFileDescriptor } from "./storage/manifest.js";
import { mapResponseToTranscript } from "./transcript/map.js";
import type { TranscribeJobPayload } from "./payload.js";
import type { SummaryEnqueuer } from "./summary/enqueue.js";
import type { RemuxEnqueuer } from "./remux/enqueue.js";

export interface TranscribeHandlerDependencies {
  audio: AudioSource;
  transcription: TranscriptionClient;
  repository: TranscriptRepository;
  logger: WorkerLogger;
  /**
   * Deployment default for the transcription language (`WHISPER_LANGUAGE`) — the third link of
   * the chain in `shared/src/transcription-language.ts`, below the meeting's own choice and the
   * user's default, which arrive in the payload. Unset means the chain ends in autodetect.
   */
  language?: string | undefined;
  /**
   * Enqueues the follow-up summary job. Omitted, the pipeline stops at the
   * transcript — which is what the tests of the transcription half do.
   */
  summaries?: SummaryEnqueuer | undefined;
  /**
   * Template the automatic summary uses when the user has chosen no default of
   * their own; the system template in production.
   */
  summaryTemplateId?: string | undefined;
  /**
   * Enqueues the job that repackages the recording into a seekable file (ADR-010). Omitted,
   * the recording keeps its chunk objects — which is what the tests of the transcription half
   * want, and what a deployment that has not turned this on would do.
   */
  remux?: RemuxEnqueuer | undefined;
  now?: () => Date;
}

export interface TranscribeOutcome {
  transcriptId: string;
  /** `false` when the job had already produced this transcript. */
  created: boolean;
  segmentCount: number;
  wordCount: number;
  /** `true` when the follow-up summary job was placed on the queue. */
  summaryEnqueued: boolean;
  /** `true` when the repackaging job was placed on the queue. */
  remuxEnqueued: boolean;
  /**
   * Set when the meeting was deleted while the job was running. Nothing was
   * written — not the transcript, not a job row, not a follow-up summary job —
   * and `transcriptId` is only the id the run would have used.
   */
  abandoned?: "meeting-deleted";
}

/**
 * Runs one `transcribe` job end to end: manifest → chunks → assembled audio →
 * Whisper → `Transcript` → PostgreSQL.
 *
 * Every step is expressed against a port, so this function is fully testable
 * without MinIO, an HTTP backend or a database. Failures leave a `failed` job
 * row behind with the machine-readable code from `errors.ts` before they are
 * rethrown for the queue to act on.
 */
export async function runTranscribeJob(
  payload: TranscribeJobPayload,
  attempt: number,
  deps: TranscribeHandlerDependencies,
): Promise<TranscribeOutcome> {
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
    attempt,
  });

  const startedAt = now().toISOString();
  const running: Job = { ...payload.job, status: "running", startedAt, finishedAt: null };
  await deps.repository.saveJob(running, scope, attempt);
  log.info({ event: "job.started" }, "transcription job started");

  try {
    const manifest = await deps.audio.loadManifest(scope);
    const session = await deps.audio.loadSession(scope);
    if (!session) {
      log.warn(
        { event: "session.metadata.missing" },
        "session metadata is gone; using the manifest finalization time as the recording start",
      );
    }
    // ADR-003 §5: the absolute recording start comes from the session object;
    // the manifest only knows when the recording was finalized.
    const recordedAt = normalizeTimestamp(session?.createdAt ?? manifest.finalizedAt, startedAt);

    const descriptor = audioFileDescriptor(manifest.audioFormat.container);
    const audio = await deps.audio.loadAudio(manifest, scope);
    log.info(
      { event: "audio.assembled", chunkCount: manifest.chunkCount, bytes: audio.byteLength },
      "audio assembled from chunk manifest",
    );

    // The last two links of the chain: what the API side resolved for this meeting, then this
    // deployment's default. `undefined` means the backend detects it (ADR-005 keeps the shape of
    // the request here, which is why the deployment default is applied here and not at enqueue).
    const language = transcriptionLanguageRequest(payload.language, deps.language);
    const response = await deps.transcription.transcribe({
      audio,
      filename: descriptor.filename,
      contentType: descriptor.contentType,
      language,
    });
    log.info(
      {
        event: "transcription.completed",
        requestedLanguage: language ?? null,
        language: response.language,
        durationSeconds: response.duration,
        segmentCount: response.segments?.length ?? 0,
      },
      "transcription backend answered",
    );

    const transcript = mapResponseToTranscript({
      response,
      jobId: payload.job.id,
      meetingId: payload.job.meetingId,
      model: deps.transcription.model,
      recordedAt,
      createdAt: now().toISOString(),
      // What the meeting ends up saying its language is has to be what the transcription was
      // actually done in. A backend that echoes no language back would otherwise leave a
      // recording we deliberately transcribed as German labeled "undetermined".
      ...(language ? { fallbackLanguage: language } : {}),
    });

    const saved = await deps.repository.saveTranscript(transcript, scope, payload.job.id);
    const wordCount = transcript.segments.reduce(
      (sum, segment) => sum + (segment.words?.length ?? 0),
      0,
    );

    const summaryEnqueued = await enqueueSummary(
      {
        ...payload,
        transcriptId: saved.transcriptId,
        createdAt: now().toISOString(),
        chosenTemplateId: session?.summaryTemplateId ?? null,
      },
      deps,
      log,
    );

    const remuxEnqueued = await enqueueRemux(payload, response.duration ?? null, deps, log);

    const succeeded: Job = {
      ...payload.job,
      status: "succeeded",
      progress: 1,
      error: null,
      resultId: saved.transcriptId,
      startedAt,
      finishedAt: now().toISOString(),
    };
    await deps.repository.saveJob(succeeded, scope, attempt);
    log.info(
      {
        event: "job.succeeded",
        transcriptId: saved.transcriptId,
        created: saved.created,
        segmentCount: transcript.segments.length,
        wordCount,
      },
      saved.created ? "transcript persisted" : "transcript already existed; job replay was a no-op",
    );

    return {
      transcriptId: saved.transcriptId,
      created: saved.created,
      segmentCount: transcript.segments.length,
      wordCount,
      summaryEnqueued,
      remuxEnqueued,
    };
  } catch (error) {
    if (error instanceof MeetingGoneError) {
      logMeetingGone(log, "transcript");
      return {
        transcriptId: transcriptIdForJob(payload.job.id),
        created: false,
        segmentCount: 0,
        wordCount: 0,
        summaryEnqueued: false,
        remuxEnqueued: false,
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
      "transcription job failed",
    );
    throw jobError;
  }
}

/**
 * Chains the summary job onto a persisted transcript (ADR-004: the summary is
 * the second half of the core path, and both halves are server-side jobs).
 *
 * WHY THIS DOES NOT FAIL THE JOB: the transcript is already committed at this
 * point. Rethrowing here would hand the queue a failure whose only retry is a
 * *second full transcription* — minutes of GPU time — to fix a queue insert
 * that takes milliseconds. So the failure is logged loudly with its own event
 * and the transcribe job still succeeds. Nothing is lost silently: the summarize
 * job id is derived from the transcript (see `ids.ts`), so replaying the
 * transcribe job or asking for the summary through the API lands on the exact
 * same id, and the singleton key keeps that from ever producing two summaries.
 */
async function enqueueSummary(
  input: TranscribeJobPayload & {
    transcriptId: string;
    createdAt: string;
    /** Template chosen before recording, straight from the session record. */
    chosenTemplateId: string | null;
  },
  deps: TranscribeHandlerDependencies,
  log: WorkerLogger,
): Promise<boolean> {
  if (!deps.summaries || !deps.summaryTemplateId) return false;
  const templateId = await resolveTemplateId(input, deps, deps.summaryTemplateId, log);
  try {
    await deps.summaries.enqueue({
      transcriptId: input.transcriptId,
      meetingId: input.job.meetingId,
      templateId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      createdAt: input.createdAt,
    });
    log.info(
      {
        event: "summary.enqueued",
        transcriptId: input.transcriptId,
        templateId,
      },
      "summary job enqueued for the persisted transcript",
    );
    return true;
  } catch (error) {
    log.error(
      { event: "summary.enqueue_failed", transcriptId: input.transcriptId, err: error },
      "transcript was persisted but the summary job could not be enqueued",
    );
    return false;
  }
}

/**
 * Picks the template the automatic summary is produced with.
 *
 * THE CHAIN, most specific first:
 *   1. the choice made for this meeting before recording started,
 *   2. the user's default template,
 *   3. the system template.
 *
 * Each link is skipped when it names a template the user cannot see — deleted,
 * or never theirs — so the chain always ends somewhere usable. A choice that has
 * gone stale between recording and summarizing is logged rather than failing the
 * summary: the recording happened, and a summary in the wrong layout is worth
 * more than none.
 *
 * This is resolved here, at enqueue time, rather than in the summarize handler,
 * because the transcribe payload is where the tenant and the user are known
 * from the recording session. The resolved id then travels in the summarize
 * payload, which keeps the summarize handler a pure function of its payload —
 * a replayed summarize job produces the same summary as the first attempt
 * instead of silently following a preference that has since changed. An
 * explicit choice, i.e. regenerate, is unaffected: it names its template.
 *
 * A lookup failure is not allowed to cost the summary. The transcript is
 * committed at this point, so falling back to the system template produces a
 * usable summary the user can regenerate, which is strictly better than none.
 */
async function resolveTemplateId(
  input: TranscribeJobPayload & { chosenTemplateId: string | null },
  deps: TranscribeHandlerDependencies,
  fallbackTemplateId: string,
  log: WorkerLogger,
): Promise<string> {
  try {
    const chosen = input.chosenTemplateId
      ? await deps.repository.findVisibleTemplateId(
          input.chosenTemplateId,
          input.tenantId,
          input.userId,
        )
      : null;
    if (input.chosenTemplateId && !chosen) {
      log.warn(
        { event: "summary.chosen_template_gone", templateId: input.chosenTemplateId },
        "the template chosen before recording is no longer available; falling back",
      );
    }
    if (chosen) return chosen;

    const preferred = await deps.repository.findDefaultTemplateId(input.tenantId, input.userId);
    return preferred ?? fallbackTemplateId;
  } catch (error) {
    log.warn(
      { event: "summary.template_resolution_failed", err: error },
      "could not resolve the summary template; using the system template",
    );
    return fallbackTemplateId;
  }
}

/**
 * Hands the finished recording on to be repackaged into a seekable file (ADR-010).
 *
 * WHY HERE AND NOT AT FINALIZE. The chunk objects have exactly two readers: playback, which
 * copes with either shape, and this job. Chaining the repackaging onto a *finished*
 * transcription is what makes the replacement raceless — by the time this runs, the only other
 * reader of the chunks is done with them. Enqueuing it when the recording was finalized would
 * mean two jobs reaching for the same objects, one of them deleting them.
 *
 * WHY A FAILURE HERE IS NOT THE JOB'S FAILURE. Same argument as the summary above, and a
 * weaker claim on top of it: the transcript is committed, and the thing that did not get queued
 * is housekeeping nobody asked for. A recording that is never repackaged plays exactly as it
 * always did. So the failure is a log line, and the derived job id means the next transcription
 * of this session lands on the same job rather than a second one.
 */
async function enqueueRemux(
  payload: TranscribeJobPayload,
  durationSeconds: number | null,
  deps: TranscribeHandlerDependencies,
  log: WorkerLogger,
): Promise<boolean> {
  if (!deps.remux) return false;
  try {
    await deps.remux.enqueue({
      meetingId: payload.job.meetingId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      sessionId: payload.sessionId,
      expectedDurationSeconds: durationSeconds,
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    log.error(
      { event: "remux.enqueue_failed", err: error },
      "could not queue the recording for repackaging; it keeps playing from its chunk objects",
    );
    return false;
  }
}

/** Keeps a malformed timestamp from failing schema validation late in the run. */
function normalizeTimestamp(value: string, fallback: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export { JobError };
