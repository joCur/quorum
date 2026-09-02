import { pino, type Logger } from "pino";

/**
 * Structured JSON logs. Every log line emitted while a job runs carries
 * `jobId`, `meetingId`, `sessionId`, `tenantId` and `userId` so a single
 * recording can be followed across the pipeline; the observability work builds
 * on these fields rather than on message text.
 */
export type WorkerLogger = Logger;

export function createLogger(level: string): WorkerLogger {
  return pino({
    level,
    base: { service: "quorum-worker" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/**
 * An error the pg-boss channel reported — a dropped connection, most of the time.
 *
 * Deliberately not `{ err: error }`: pino's default serializer walks an error's own enumerable
 * properties, and node-postgres hangs its entire `Client` — connection parameters, socket state,
 * type maps, pool counters — off a "Connection terminated unexpectedly" error. An ordinary
 * shutdown would otherwise write a multi-kilobyte line per pooled connection. Message, pg error
 * code and stack are the parts anyone reads.
 */
export function logQueueError(log: WorkerLogger, error: unknown): void {
  if (!(error instanceof Error)) {
    log.error({ event: "queue.error", message: String(error) }, "pg-boss error");
    return;
  }
  const code = (error as { code?: unknown }).code;
  log.error(
    {
      event: "queue.error",
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
      stack: error.stack,
    },
    "pg-boss error",
  );
}

/**
 * The one log line a deleted meeting produces, on both pipelines.
 *
 * Terminal and deliberately quiet: `info`, not `warn` or `error`. Someone
 * deleting a recording while its pipeline is still running is normal operation,
 * not an incident, and a job abandoned this way must never reach the
 * dead-letter queue — there is nothing for an operator to replay.
 *
 * NO JOB ROW IS WRITTEN either, which is the point of the whole check: the
 * deletion cascade removes a meeting's `jobs` rows in the same transaction as
 * its artifacts, so recording a terminal status here would resurrect exactly
 * the residue the cascade just erased. The abandonment is expressed to the
 * queue — the job completes instead of failing — and to this line, which
 * carries the correlated job, meeting, session, tenant and user ids from the
 * handler's child logger.
 */
export function logMeetingGone(
  log: WorkerLogger,
  artifact: "transcript" | "summary" | "remux",
): void {
  log.info(
    { event: "job.abandoned", reason: "meeting-deleted", artifact },
    `meeting was deleted while the job was running; the ${artifact} was discarded`,
  );
}
