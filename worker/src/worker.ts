import type { JobResult, JobWithMetadata, PgBoss } from "pg-boss";
import { runTranscribeJob, type TranscribeHandlerDependencies } from "./handler.js";
import {
  parseRemuxJobPayload,
  parseSummarizeJobPayload,
  parseTranscribeJobPayload,
  REMUX_DEAD_LETTER_QUEUE,
  REMUX_QUEUE,
  SUMMARIZE_DEAD_LETTER_QUEUE,
  SUMMARIZE_QUEUE,
  TRANSCRIBE_DEAD_LETTER_QUEUE,
  TRANSCRIBE_QUEUE,
} from "./payload.js";
import { runRemuxJob, type RemuxHandlerDependencies } from "./remux/handler.js";
import { runSummarizeJob, type SummarizeHandlerDependencies } from "./summary/handler.js";
import { toJobError } from "./errors.js";
import type { WorkerLogger } from "./logger.js";
import type { JobOutcome, WorkerMetrics } from "./observability/metrics.js";

/** Queue policy shared by every job type; the numbers come from the config. */
export interface QueuePolicy {
  concurrency: number;
  retryLimit: number;
  retryDelaySeconds: number;
  jobExpireSeconds: number;
  /**
   * Job counters and durations. Optional so the handler tests stay free of it;
   * the running worker always supplies one.
   */
  metrics?: WorkerMetrics | undefined;
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
      settleAll(jobs, options, (job) =>
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
      settleAll(jobs, options, (job) =>
        runSummarizeJob(parseSummarizeJobPayload(job.data), job.retryCount, options),
      ),
  );
}

export interface RemuxWorkerOptions extends RemuxHandlerDependencies, QueuePolicy {
  boss: PgBoss;
}

/**
 * The retry budget here is for object storage alone — a hiccup between writing the artifact and
 * reading it back — because the other way this job fails is a container the remuxer cannot read,
 * which will read no better on the fourth attempt. A dead letter costs nobody a recording: the
 * chunks go only after the artifact is verified, so a failed job leaves a meeting that plays
 * exactly as it did before (ADR-010).
 */
export async function startRemuxWorker(options: RemuxWorkerOptions): Promise<string> {
  await createQueues(options.boss, REMUX_QUEUE, REMUX_DEAD_LETTER_QUEUE, options);

  return options.boss.work(
    REMUX_QUEUE,
    workOptions(options),
    async (jobs: JobWithMetadata<unknown>[]) =>
      settleAll(jobs, options, (job) =>
        runRemuxJob(parseRemuxJobPayload(job.data), job.retryCount, options),
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

interface SettleContext {
  logger: WorkerLogger;
  metrics?: WorkerMetrics | undefined;
}

async function settleAll(
  jobs: JobWithMetadata<unknown>[],
  context: SettleContext,
  run: (job: JobWithMetadata<unknown>) => Promise<unknown>,
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    results.push(await settle(job, context, run));
  }
  return results;
}

/**
 * Runs one attempt and turns its outcome into a pg-boss result, a log line and a
 * metric sample.
 *
 * This is the only place that sees every attempt of every queue, which is why
 * the instrumentation sits here rather than in the two handlers: one funnel
 * means the two job types cannot drift into reporting different things, and a
 * third queue is instrumented by construction.
 */
async function settle(
  job: JobWithMetadata<unknown>,
  { logger, metrics }: SettleContext,
  run: (job: JobWithMetadata<unknown>) => Promise<unknown>,
): Promise<JobResult> {
  const startedAt = process.hrtime.bigint();
  metrics?.jobStarted(job.name);
  const record = (outcome: JobOutcome): void => {
    metrics?.jobFinished(job.name);
    metrics?.observeJob({
      queue: job.name,
      outcome,
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
    });
  };

  try {
    const outcome = await run(job);
    // A meeting deleted mid-flight is neither a success nor a failure: nothing
    // was produced and nothing is wrong. Counting it as `succeeded` would make
    // a bulk deletion look like a throughput spike.
    record(isAbandoned(outcome) ? "abandoned" : "succeeded");
    return { id: job.id, status: "completed", output: outcome };
  } catch (error) {
    const jobError = toJobError(error);
    const exhausted = job.retryCount >= job.retryLimit;
    const status = jobError.retryable && !exhausted ? "failed" : "deadletter";
    record(status === "deadletter" ? "deadletter" : "failed");
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

/** The abandonment marker both handlers set when the meeting was deleted mid-run. */
function isAbandoned(outcome: unknown): boolean {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    "abandoned" in outcome &&
    (outcome as { abandoned?: unknown }).abandoned !== undefined
  );
}
