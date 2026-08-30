import {
  collectDefaultMetrics,
  Gauge,
  Registry,
  type Registry as PrometheusRegistry,
} from "@prometheus-io/client";

/**
 * Prometheus exposition for the API process.
 *
 * WHY PROMETHEUS AND NOT OPENTELEMETRY: the open question named "OpenTelemetry +
 * Grafana" as a candidate. What the acceptance criterion actually needs — see a
 * stuck job without reading code — is queue depth, queue age and job outcomes.
 * Those are three numbers a scrape endpoint answers directly, whereas an OTel
 * setup adds an SDK per service plus a collector before the first number
 * appears. The exposition format below is what an OTel collector would emit
 * anyway, so adopting traces later is additive rather than a rewrite.
 *
 * Metric names are stable API: the alert rules and the dashboard are written
 * against them, so renaming one is a breaking change for the ops side.
 */

/** Prefix shared by every metric this project emits, in both services. */
export const METRIC_PREFIX = "quorum_";

/**
 * Queue states worth exposing. `completed` and `cancelled` are deliberately
 * absent: pg-boss keeps completed rows around for its retention window, so a
 * gauge over them measures retention rather than health, and nothing alerts on
 * it.
 */
export const OBSERVED_QUEUE_STATES = ["created", "retry", "active", "failed"] as const;

export type ObservedQueueState = (typeof OBSERVED_QUEUE_STATES)[number];

/** One row of the queue snapshot the collector turns into gauge samples. */
export interface QueueStateCount {
  queue: string;
  state: ObservedQueueState;
  count: number;
}

/** Age of the oldest job that is eligible to run but has not started yet. */
export interface QueueBacklogAge {
  queue: string;
  ageSeconds: number;
}

export interface QueueSnapshot {
  states: QueueStateCount[];
  oldestPending: QueueBacklogAge[];
}

/** Reads the queue state from wherever it lives; the only I/O these metrics do. */
export interface QueueSnapshotSource {
  snapshot(): Promise<QueueSnapshot>;
}

export interface ServerMetricsOptions {
  /**
   * Queue state source. Scraped on demand rather than sampled on a timer, so the
   * numbers are as fresh as the scrape and an unscraped instance costs nothing.
   */
  queues?: QueueSnapshotSource | undefined;
  /** Existing registry to add to; a fresh one by default. */
  registry?: PrometheusRegistry | undefined;
  /** Node process metrics (heap, event loop lag, file descriptors). */
  collectProcessMetrics?: boolean;
}

export interface ServerMetrics {
  readonly registry: PrometheusRegistry;
  readonly contentType: string;
  /** Renders the exposition text, refreshing the queue gauges first. */
  render(): Promise<string>;
}

/**
 * Builds the API metrics registry.
 *
 * The queue gauges live here rather than in the worker on purpose: they describe
 * the queue, not a consumer of it. A worker that has crashed is exactly the
 * situation the queue-depth alert has to survive, and a metric that disappears
 * with the process it describes cannot do that. The API is the always-on
 * process, so it reports the queue.
 */
export function createServerMetrics(options: ServerMetricsOptions = {}): ServerMetrics {
  const registry = options.registry ?? new Registry();

  if (options.collectProcessMetrics !== false) {
    collectDefaultMetrics({ register: registry, prefix: METRIC_PREFIX });
  }

  const queueJobs = new Gauge({
    name: `${METRIC_PREFIX}queue_jobs`,
    help: "Jobs on a queue by pg-boss state.",
    labelNames: ["queue", "state"] as const,
    registers: [registry],
  });

  const oldestPending = new Gauge({
    name: `${METRIC_PREFIX}queue_oldest_pending_age_seconds`,
    help: "Age of the oldest job that is due to run but has not started yet, per queue. This is the signal behind the stuck-queue alert.",
    labelNames: ["queue"] as const,
    registers: [registry],
  });

  const snapshotFailures = new Gauge({
    name: `${METRIC_PREFIX}queue_snapshot_failed`,
    help: "1 when the last attempt to read queue state from the database failed, 0 otherwise. A stale queue gauge is worse than an obviously broken one.",
    registers: [registry],
  });
  snapshotFailures.set(0);

  const source = options.queues;

  async function refresh(): Promise<void> {
    if (!source) return;
    let snapshot: QueueSnapshot;
    try {
      snapshot = await source.snapshot();
    } catch {
      // The gauges keep their previous values and the failure gauge flips, so a
      // dashboard shows "we do not know" rather than "the queue is empty".
      snapshotFailures.set(1);
      return;
    }
    snapshotFailures.set(0);
    // Reset first: a queue that drops back to zero has to stop reporting its old
    // value, and a `set` only touches label combinations that are still present.
    queueJobs.reset();
    oldestPending.reset();
    for (const row of snapshot.states) {
      queueJobs.set({ queue: row.queue, state: row.state }, row.count);
    }
    for (const row of snapshot.oldestPending) {
      oldestPending.set({ queue: row.queue }, row.ageSeconds);
    }
  }

  return {
    registry,
    contentType: registry.contentType,
    async render(): Promise<string> {
      await refresh();
      return registry.metrics();
    },
  };
}
