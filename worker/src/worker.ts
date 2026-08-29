import type { JobResult, JobWithMetadata, PgBoss } from "pg-boss";
import { runTranscribeJob, type TranscribeHandlerDependencies } from "./handler.js";
import {
  parseTranscribeJobPayload,
  TRANSCRIBE_DEAD_LETTER_QUEUE,
  TRANSCRIBE_QUEUE,
} from "./payload.js";
import { toJobError } from "./errors.js";

export interface TranscribeWorkerOptions extends TranscribeHandlerDependencies {
  boss: PgBoss;
  concurrency: number;
  retryLimit: number;
  retryDelaySeconds: number;
  jobExpireSeconds: number;
}

/**
 * Binds the transcription handler to pg-boss.
 *
 * Retry policy: transient failures (Whisper still loading a model, MinIO
 * hiccup, database blip) get `retryLimit` attempts with exponential backoff,
 * which comfortably covers a Whisper container that is slow to start. Terminal
 * failures — a session that was never finalized, audio the backend cannot
 * decode, a payload we do not understand — go straight to the dead-letter queue
 * without burning retries, because repeating them cannot change the outcome.
 *
 * Dead-lettered jobs land on `transcribe-dead-letter` and stay there for
 * inspection; nothing consumes that queue. Once the cause is fixed, an operator
 * replays them with pg-boss's `redrive`, and the idempotent write means a
 * replay is safe even for jobs that had already produced a transcript.
 */
export async function startTranscribeWorker(options: TranscribeWorkerOptions): Promise<string> {
  const { boss } = options;

  await boss.createQueue(TRANSCRIBE_DEAD_LETTER_QUEUE);
  await boss.createQueue(TRANSCRIBE_QUEUE, {
    policy: "standard",
    retryLimit: options.retryLimit,
    retryDelay: options.retryDelaySeconds,
    retryBackoff: true,
    expireInSeconds: options.jobExpireSeconds,
    deadLetter: TRANSCRIBE_DEAD_LETTER_QUEUE,
  });

  const workOptions = {
    batchSize: 1,
    includeMetadata: true,
    perJobResults: true,
    localConcurrency: options.concurrency,
  } as const;

  return boss.work(TRANSCRIBE_QUEUE, workOptions, async (jobs: JobWithMetadata<unknown>[]) => {
    const results: JobResult[] = [];
    for (const job of jobs) {
      results.push(await settle(job, options));
    }
    return results;
  });
}

async function settle(
  job: JobWithMetadata<unknown>,
  options: TranscribeWorkerOptions,
): Promise<JobResult> {
  const { logger } = options;
  try {
    const payload = parseTranscribeJobPayload(job.data);
    const outcome = await runTranscribeJob(payload, job.retryCount, options);
    return { id: job.id, status: "completed", output: outcome };
  } catch (error) {
    const jobError = toJobError(error);
    const exhausted = job.retryCount >= job.retryLimit;
    const status = jobError.retryable && !exhausted ? "failed" : "deadletter";
    logger.error(
      {
        event: "job.settled",
        queueJobId: job.id,
        code: jobError.code,
        retryable: jobError.retryable,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        status,
      },
      status === "deadletter"
        ? "job moved to the dead-letter queue"
        : "job failed and will be retried",
    );
    return {
      id: job.id,
      status,
      output: { code: jobError.code, message: jobError.message },
    };
  }
}
