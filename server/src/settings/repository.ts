import postgres from "postgres";
import type { UserSettings, UserSettingsUpdate } from "@quorum/shared";
import { UserSettingsSchema } from "@quorum/shared";

/**
 * Persistence for the preferences that belong to a user (ADR-001: read and written under the
 * tenant and user scope, never by id alone).
 *
 * TABLE OWNERSHIP: `user_settings` is created by the worker, for the same reason
 * `summary_templates` is — the pipeline resolves a user's default template with no API server in
 * the picture, so the table has to exist whether or not one is running. The API reads and writes
 * rows in it and never migrates it, exactly as `server/src/templates/repository.ts` describes for
 * its own table.
 *
 * TWO WRITERS, ONE ROW: the template store owns `default_template_id`, this store owns the
 * transcription language. Both upsert on the (tenant, user) primary key and each names only its
 * own column, so a write from one never clears what the other stored. Splitting them by column
 * rather than merging them into one store keeps the summary feature's preference next to the
 * summary feature's code, which is where anyone changing it will look.
 */

/**
 * The two ways this store can find the schema not ready, both of which happen in normal
 * operation rather than only in a broken deployment.
 *
 * `undefined_table` is a stack whose worker has never started. `undefined_column` is the more
 * common one and the reason it is handled at all: `user_settings` already exists in every
 * deployment that used the default summary template, and the transcription language is a column
 * added to it. Between the API rolling out and the worker restarting with the new migration list,
 * the table is there and the column is not — a window in which naming the column raises 42703 on
 * every read and every write.
 */
const UNDEFINED_TABLE = "42P01";
const UNDEFINED_COLUMN = "42703";

/** Tenant and user a request runs under (ADR-001). Never read from a request body. */
export interface UserSettingsScope {
  readonly tenantId: string;
  readonly userId: string;
}

/** Everything a user has chosen, with the untouched defaults filled in. */
export const EMPTY_USER_SETTINGS: UserSettings = { transcriptionLanguage: null };

/**
 * Raised when the schema cannot hold the preference yet — no `user_settings` table, or one
 * without the column.
 *
 * Only writes raise it. A read has a truthful answer in that state ("nothing is stored"), but a
 * write does not: reporting success would tell the user their choice was saved when the statement
 * never ran, and the screen would go on showing it until the next reload quietly dropped it.
 */
export class UserSettingsUnavailableError extends Error {
  constructor() {
    super("The user settings store is not ready yet.");
    this.name = "UserSettingsUnavailableError";
  }
}

export interface UserSettingsStore {
  /** What this user has chosen. A user who has chosen nothing reads as all defaults. */
  findSettings(scope: UserSettingsScope): Promise<UserSettings>;
  /** Stores the named fields and leaves the rest alone; returns the settings as they now stand. */
  updateSettings(scope: UserSettingsScope, update: UserSettingsUpdate): Promise<UserSettings>;
}

export class PostgresUserSettingsStore implements UserSettingsStore {
  private readonly sql: postgres.Sql;

  /**
   * Takes a connection string in production. An already-built `Sql` is the test seam: what this
   * store mostly does is decide which database errors are a state to absorb and which are a
   * failure to report, and that decision is only observable by making the database raise them.
   */
  constructor(
    connection: string | postgres.Sql,
    options: postgres.Options<Record<string, never>> = {},
  ) {
    this.sql =
      typeof connection === "string" ? postgres(connection, { max: 2, ...options }) : connection;
  }

  /**
   * A missing table, a missing column, a missing row and a row of nulls all read as
   * "nothing chosen".
   *
   * That is what lets the recording endpoint ask for a user's default mid-deploy, or on a stack
   * whose worker has never started: the answer is the same as for a user who has never opened the
   * settings screen, and the chain carries on to the deployment default rather than failing a
   * recording — or the whole settings screen — over a preference that cannot be stored yet.
   */
  async findSettings(scope: UserSettingsScope): Promise<UserSettings> {
    try {
      const rows = await this.sql<{ transcription_language: string | null }[]>`
        SELECT transcription_language
          FROM user_settings
         WHERE tenant_id = ${scope.tenantId}
           AND user_id = ${scope.userId}
         LIMIT 1
      `;
      return parseSettings(rows[0]?.transcription_language ?? null);
    } catch (error) {
      if (isSchemaNotReady(error)) return { ...EMPTY_USER_SETTINGS };
      throw error;
    }
  }

  /**
   * Unlike the read, this refuses rather than pretending: see `UserSettingsUnavailableError`.
   */
  async updateSettings(
    scope: UserSettingsScope,
    update: UserSettingsUpdate,
  ): Promise<UserSettings> {
    if (!("transcriptionLanguage" in update)) return this.findSettings(scope);
    const language = update.transcriptionLanguage ?? null;
    try {
      const rows = await this.sql<{ transcription_language: string | null }[]>`
        INSERT INTO user_settings (tenant_id, user_id, transcription_language)
        VALUES (${scope.tenantId}, ${scope.userId}, ${language})
        ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET transcription_language = EXCLUDED.transcription_language, updated_at = now()
        RETURNING transcription_language
      `;
      return parseSettings(rows[0]?.transcription_language ?? null);
    } catch (error) {
      if (isSchemaNotReady(error)) throw new UserSettingsUnavailableError();
      throw error;
    }
  }
}

/** In-memory store for tests and for the unauthenticated development instance. */
export class InMemoryUserSettingsStore implements UserSettingsStore {
  private readonly rows = new Map<string, UserSettings>();

  async findSettings(scope: UserSettingsScope): Promise<UserSettings> {
    return { ...EMPTY_USER_SETTINGS, ...this.rows.get(rowKey(scope)) };
  }

  async updateSettings(
    scope: UserSettingsScope,
    update: UserSettingsUpdate,
  ): Promise<UserSettings> {
    const next: UserSettings = {
      ...(await this.findSettings(scope)),
      ...("transcriptionLanguage" in update
        ? { transcriptionLanguage: update.transcriptionLanguage ?? null }
        : {}),
    };
    this.rows.set(rowKey(scope), next);
    return next;
  }
}

/** The (tenant, user) primary key of `user_settings`, as one map key. */
function rowKey(scope: UserSettingsScope): string {
  return `${scope.tenantId} ${scope.userId}`;
}

/**
 * A stored language the current build no longer offers reads as no choice rather than being handed
 * on. The column is plain text and outlives any one version of the picker, and a tag the pipeline
 * would only get rejected for is worth less than falling through to the next link of the chain.
 */
function parseSettings(transcriptionLanguage: string | null): UserSettings {
  const parsed = UserSettingsSchema.safeParse({ transcriptionLanguage });
  return parsed.success ? parsed.data : { ...EMPTY_USER_SETTINGS };
}

/** The table has not been created yet, or it predates the column this store writes. */
function isSchemaNotReady(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === UNDEFINED_TABLE || code === UNDEFINED_COLUMN;
}
