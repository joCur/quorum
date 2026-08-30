import postgres from "postgres";
import {
  OBSERVED_QUEUE_STATES,
  type ObservedQueueState,
  type QueueSnapshot,
  type QueueSnapshotSource,
} from "./metrics.js";

/** PostgreSQL `undefined_table` — pg-boss has not created its schema yet. */
const UNDEFINED_TABLE = "42P01";

/**
 * Reads queue depth and backlog age straight out of pg-boss's own tables.
 *
 * WHY SQL AND NOT THE pg-boss API: `getQueueSize` answers one number for one
 * queue, and the diagnosis the acceptance criterion asks for needs the split by
 * state — a queue with ten `active` jobs is a slow worker, a queue with ten
 * `created` jobs and none active is a worker that is not consuming at all, and
 * those two look identical in a single depth number. The tables are pg-boss's
 * public contract for exactly this kind of inspection, and the query is
 * read-only.
 */
export class PostgresQueueSnapshot implements QueueSnapshotSource {
  private readonly sql: postgres.Sql;
  private readonly ownsConnection: boolean;

  constructor(connection: string | postgres.Sql) {
    if (typeof connection === "string") {
      // One connection is plenty: this runs once per scrape.
      this.sql = postgres(connection, { max: 1 });
      this.ownsConnection = true;
    } else {
      this.sql = connection;
      this.ownsConnection = false;
    }
  }

  async snapshot(): Promise<QueueSnapshot> {
    try {
      const states = await this.sql<
        { queue: string; state: ObservedQueueState; count: string }[]
      >`SELECT name AS queue, state::text AS state, count(*)::text AS count
          FROM pgboss.job
         WHERE state::text = ANY (${this.sql.array(
           OBSERVED_QUEUE_STATES as unknown as string[],
         )}::text[])
         GROUP BY name, state`;

      // `start_after` is what makes this the *actionable* backlog: a job waiting
      // out its retry delay is working as designed, and counting its wait as
      // backlog age would page someone for a healthy retry.
      const oldest = await this.sql<{ queue: string; age_seconds: string }[]>`SELECT name AS queue,
               EXTRACT(EPOCH FROM (now() - min(created_on)))::text AS age_seconds
          FROM pgboss.job
         WHERE state IN ('created', 'retry')
           AND start_after <= now()
         GROUP BY name`;

      return {
        states: states.map((row) => ({
          queue: row.queue,
          state: row.state,
          count: Number(row.count),
        })),
        oldestPending: oldest.map((row) => ({
          queue: row.queue,
          ageSeconds: Number(row.age_seconds),
        })),
      };
    } catch (error) {
      // A stack that has never enqueued anything has no pgboss schema yet. That
      // is an empty queue, not a broken scrape.
      if (isUndefinedTable(error)) return { states: [], oldestPending: [] };
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.ownsConnection) await this.sql.end();
  }
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNDEFINED_TABLE
  );
}
