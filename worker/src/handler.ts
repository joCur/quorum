import type { Job } from "@quorum/shared";
import type { AudioSource } from "./storage/audio-source.js";
import type { TranscriptionClient } from "./whisper/client.js";
import type { TranscriptRepository } from "./db/repository.js";
import type { WorkerLogger } from "./logger.js";
import { JobError, toJobError } from "./errors.js";
import { audioFileDescriptor } from "./storage/manifest.js";
import { mapResponseToTranscript } from "./transcript/map.js";
import type { TranscribeJobPayload } from "./payload.js";
import type { SummaryEnqueuer } from "./summary/enqueue.js";

export interface TranscribeHandlerDependencies {
  audio: AudioSource;
  transcription: TranscriptionClient;
  repository: TranscriptRepository;
  logger: WorkerLogger;
  /** Language hint forwarded to the backend; omitted means auto-detect. */
  language?: string | undefined;
  /**
   * Enqueues the follow-up summary job. Omitted, the pipeline stops at the
   * transcript — which is what the tests of the transcription half do.
   */
  summaries?: SummaryEnqueuer | undefined;
  /** Template the automatic summary uses; the system default in production. */
  summaryTemplateId?: string | undefined;
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

    const response = await deps.transcription.transcribe({
      audio,
      filename: descriptor.filename,
      contentType: descriptor.contentType,
      language: deps.language,
    });
    log.info(
      {
        event: "transcription.completed",
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
    });

    const saved = await deps.repository.saveTranscript(transcript, scope, payload.job.id);
    const wordCount = transcript.segments.reduce(
      (sum, segment) => sum + (segment.words?.length ?? 0),
      0,
    );

    const summaryEnqueued = await enqueueSummary(
      { ...payload, transcriptId: saved.transcriptId, createdAt: now().toISOString() },
      deps,
      log,
    );

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
    };
  } catch (error) {
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
  input: TranscribeJobPayload & { transcriptId: string; createdAt: string },
  deps: TranscribeHandlerDependencies,
  log: WorkerLogger,
): Promise<boolean> {
  if (!deps.summaries || !deps.summaryTemplateId) return false;
  try {
    await deps.summaries.enqueue({
      transcriptId: input.transcriptId,
      meetingId: input.job.meetingId,
      templateId: deps.summaryTemplateId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      createdAt: input.createdAt,
    });
    log.info(
      {
        event: "summary.enqueued",
        transcriptId: input.transcriptId,
        templateId: deps.summaryTemplateId,
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

/** Keeps a malformed timestamp from failing schema validation late in the run. */
function normalizeTimestamp(value: string, fallback: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export { JobError };
