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
