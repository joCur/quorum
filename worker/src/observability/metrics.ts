import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type Registry as PrometheusRegistry,
} from "@prometheus-io/client";

/** Prefix shared with the API process; see `docs/observability.md`. */
export const METRIC_PREFIX = "quorum_";

/**
 * How a job attempt ended, as a metric label.
 *
 * These are attempt outcomes, not job outcomes — a job that fails twice and then
 * succeeds contributes two `failed` and one `succeeded`. That is what makes the
 * failure rate a rate: dividing `failed` by the total says how much work is
 * being redone, which is exactly the number that goes bad when a backend starts
 * flapping.
 */
export const JOB_OUTCOMES = ["succeeded", "failed", "deadletter", "abandoned"] as const;

export type JobOutcome = (typeof JOB_OUTCOMES)[number];

export interface JobObservation {
  /** Queue the attempt ran on — `transcribe` or `summarize`. */
  queue: string;
  outcome: JobOutcome;
  durationSeconds: number;
}

export interface WorkerMetrics {
  readonly registry: PrometheusRegistry;
  readonly contentType: string;
  /** Called once per finished attempt. */
  observeJob(observation: JobObservation): void;
  /** Bracket around a running attempt, so a hung job is visible as in-flight. */
  jobStarted(queue: string): void;
  jobFinished(queue: string): void;
  render(): Promise<string>;
}

export interface WorkerMetricsOptions {
  registry?: PrometheusRegistry | undefined;
  collectProcessMetrics?: boolean;
}

/**
 * Job execution metrics for the worker process.
 *
 * Buckets run from a second to an hour because that is the real spread: a
 * summary is a single API call measured in seconds, a transcription of a long
 * meeting is minutes to tens of minutes of GPU time. Linear buckets would put
 * every transcription in one bin and every summary in another, which tells you
 * nothing about either.
 */
export function createWorkerMetrics(options: WorkerMetricsOptions = {}): WorkerMetrics {
  const registry = options.registry ?? new Registry();

  if (options.collectProcessMetrics !== false) {
    collectDefaultMetrics({ register: registry, prefix: METRIC_PREFIX });
  }

  const jobsTotal = new Counter({
    name: `${METRIC_PREFIX}jobs_total`,
    help: "Finished job attempts by queue and outcome.",
    labelNames: ["queue", "outcome"] as const,
    registers: [registry],
  });

  const jobDuration = new Histogram({
    name: `${METRIC_PREFIX}job_duration_seconds`,
    help: "Wall-clock duration of a job attempt, from dequeue to outcome.",
    labelNames: ["queue", "outcome"] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    registers: [registry],
  });

  const jobsInFlight = new Gauge({
    name: `${METRIC_PREFIX}jobs_in_flight`,
    help: "Job attempts this process is currently running.",
    labelNames: ["queue"] as const,
    registers: [registry],
  });

  // Pre-seed the outcome series. Without this a queue that has never failed has
  // no `failed` sample at all, and a failure-rate expression over a missing
  // series returns nothing instead of zero — a silent alert instead of a green
  // one.
  for (const queue of ["transcribe", "summarize"]) {
    jobsInFlight.set({ queue }, 0);
    for (const outcome of JOB_OUTCOMES) {
      jobsTotal.inc({ queue, outcome }, 0);
    }
  }

  return {
    registry,
    contentType: registry.contentType,
    observeJob({ queue, outcome, durationSeconds }): void {
      jobsTotal.inc({ queue, outcome });
      jobDuration.observe({ queue, outcome }, durationSeconds);
    },
    jobStarted(queue): void {
      jobsInFlight.inc({ queue });
    },
    jobFinished(queue): void {
      jobsInFlight.dec({ queue });
    },
    render(): Promise<string> {
      return registry.metrics();
    },
  };
}

/**
 * GPU UTILIZATION — a documented hook, not an implementation.
 *
 * The issue lists GPU load among the job metrics, but the GPU is not the
 * worker's: transcription runs in the `whisper` container, and in development
 * there is no GPU at all. Scraping it from this process would mean shelling out
 * to `nvidia-smi` inside a container that has no driver mounted, which is a fake
 * metric that reports zero on every developer machine.
 *
 * The standard answer is DCGM Exporter (`nvidia/dcgm-exporter`) as a sidecar on
 * the GPU host, scraped by the same Prometheus as the two services here. It
 * publishes `DCGM_FI_DEV_GPU_UTIL` and `DCGM_FI_DEV_FB_USED` per device, which
 * is what a "is the GPU the bottleneck?" panel needs. Adding it belongs with the
 * GPU compose override, next to the device reservation it depends on, and it
 * needs no code in this repository.
 */
export const GPU_METRICS_ARE_EXTERNAL = true;
