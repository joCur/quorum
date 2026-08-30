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
