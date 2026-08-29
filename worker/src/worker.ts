import type { JobResult, JobWithMetadata, PgBoss } from "pg-boss";
import { runTranscribeJob, type TranscribeHandlerDependencies } from "./handler.js";
import {
  parseSummarizeJobPayload,
  parseTranscribeJobPayload,
  SUMMARIZE_DEAD_LETTER_QUEUE,
  SUMMARIZE_QUEUE,
  TRANSCRIBE_DEAD_LETTER_QUEUE,
  TRANSCRIBE_QUEUE,
} from "./payload.js";
import { runSummarizeJob, type SummarizeHandlerDependencies } from "./summary/handler.js";
import { toJobError } from "./errors.js";
import type { WorkerLogger } from "./logger.js";

/** Queue policy shared by both job types; the numbers come from the config. */
export interface QueuePolicy {
  concurrency: number;
  retryLimit: number;
  retryDelaySeconds: number;
  jobExpireSeconds: number;
}

export interface TranscribeWorkerOptions extends TranscribeHandlerDependencies, QueuePolicy {
  boss: PgBoss;
}

export interface SummarizeWorkerOptions extends SummarizeHandlerDependencies, QueuePolicy {
  boss: PgBoss;
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
  await createQueues(options.boss, TRANSCRIBE_QUEUE, TRANSCRIBE_DEAD_LETTER_QUEUE, options);

  return options.boss.work(
    TRANSCRIBE_QUEUE,
    workOptions(options),
    async (jobs: JobWithMetadata<unknown>[]) =>
      settleAll(jobs, options.logger, (job) =>
        runTranscribeJob(parseTranscribeJobPayload(job.data), job.retryCount, options),
      ),
  );
}

/**
 * Binds the summary handler to pg-boss.
 *
 * Same shape as the transcription worker, but the cost profile is inverted: a
 * summary attempt is a paid API call rather than local GPU time, so the retry
 * budget exists for backend outages and rate limits only. Everything the model
 * itself gets wrong — an unparseable answer that survived the repair turn, a
 * rejected request, a missing transcript — is terminal on the first try and
 * dead-letters straight away, because paying for the same wrong answer four
 * times helps nobody.
 */
export async function startSummarizeWorker(options: SummarizeWorkerOptions): Promise<string> {
  await createQueues(options.boss, SUMMARIZE_QUEUE, SUMMARIZE_DEAD_LETTER_QUEUE, options);

  return options.boss.work(
    SUMMARIZE_QUEUE,
    workOptions(options),
    async (jobs: JobWithMetadata<unknown>[]) =>
      settleAll(jobs, options.logger, (job) =>
        runSummarizeJob(parseSummarizeJobPayload(job.data), job.retryCount, options),
      ),
  );
}

async function createQueues(
  boss: PgBoss,
  queue: string,
  deadLetter: string,
  policy: QueuePolicy,
): Promise<void> {
  await boss.createQueue(deadLetter);
  await boss.createQueue(queue, {
    policy: "standard",
    retryLimit: policy.retryLimit,
    retryDelay: policy.retryDelaySeconds,
    retryBackoff: true,
    expireInSeconds: policy.jobExpireSeconds,
    deadLetter,
  });
}

function workOptions(policy: QueuePolicy) {
  return {
    batchSize: 1,
    includeMetadata: true,
    perJobResults: true,
    localConcurrency: policy.concurrency,
  } as const;
}

async function settleAll(
  jobs: JobWithMetadata<unknown>[],
  logger: WorkerLogger,
  run: (job: JobWithMetadata<unknown>) => Promise<unknown>,
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    results.push(await settle(job, logger, run));
  }
  return results;
}

async function settle(
  job: JobWithMetadata<unknown>,
  logger: WorkerLogger,
  run: (job: JobWithMetadata<unknown>) => Promise<unknown>,
): Promise<JobResult> {
  try {
    const outcome = await run(job);
    return { id: job.id, status: "completed", output: outcome };
  } catch (error) {
    const jobError = toJobError(error);
    const exhausted = job.retryCount >= job.retryLimit;
    const status = jobError.retryable && !exhausted ? "failed" : "deadletter";
    logger.error(
      {
        event: "job.settled",
        queueJobId: job.id,
        queue: job.name,
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
