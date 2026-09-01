/**
 * Log shape for the API process.
 *
 * Fastify brings its own pino, so this only supplies the three settings that
 * make an API line and a worker line searchable with the same query: a `service`
 * field, ISO timestamps instead of epoch milliseconds, and `level` as a word
 * rather than a number. `docs/observability.md` documents the resulting schema
 * and the correlation fields every line is expected to carry.
 */

/** Identifies the emitting process; the worker sets `quorum-worker`. */
export const LOGGER_BASE = { service: "quorum-server" } as const;

/** ISO-8601 timestamps — greppable by a human, parseable by every log backend. */
export const LOGGER_TIMESTAMP = (): string => `,"time":"${new Date().toISOString()}"`;

export const LOGGER_FORMATTERS = {
  level: (label: string): Record<string, unknown> => ({ level: label }),
} as const;

/** The part of a logger the pieces below need; Fastify's `app.log` satisfies it. */
export interface ErrorLogger {
  error(fields: Record<string, unknown>, message: string): void;
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
export function logQueueError(log: ErrorLogger, error: unknown): void {
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
