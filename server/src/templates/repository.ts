import postgres from "postgres";
import {
  SummaryTemplateSchema,
  SUMMARY_SCHEMA_VERSION,
  type SummaryTemplate,
  type SummaryTemplateDraft,
} from "@quorum/shared";

/**
 * Persistence for summary templates (ADR-004).
 *
 * TABLE OWNERSHIP: `summary_templates` is created and seeded by the worker — it
 * needs the system template to exist before it can summarize anything, and it
 * comes up whether or not an API server is running. The API therefore reads and
 * writes rows in that table but never migrates it, which keeps a single
 * migration owner per table exactly as `server/src/meetings/schema.ts`
 * describes. The two writers do not collide: the worker only ever inserts the
 * system template's `(id, version)`, the API only ever inserts `user`-scoped
 * rows. Consolidating migrations into one owner stays the open follow-up.
 *
 * IMMUTABLE VERSIONS: an edit inserts `(id, version + 1)` and leaves the old row
 * alone (ADR-004 §2). A summary snapshotted from version 3 must stay explicable
 * after the user has edited the template five more times.
 */

/** PostgreSQL `undefined_table` — the worker has not applied its schema yet. */
const UNDEFINED_TABLE = "42P01";

/** Tenant and user a request runs under (ADR-001). Never read from a request body. */
export interface TemplateScope {
  readonly tenantId: string;
  readonly userId: string;
}

/** Raised when the templates table does not exist yet, i.e. no worker has ever started. */
export class TemplatesUnavailableError extends Error {
  constructor() {
    super("The summary templates store is not ready yet.");
    this.name = "TemplatesUnavailableError";
  }
}

export interface SummaryTemplateStore {
  /**
   * The system template plus the caller's own templates, each at its highest
   * stored version, ordered system-first and then by name.
   */
  listTemplates(scope: TemplateScope): Promise<SummaryTemplate[]>;
  /** Highest version of one template, or `null` when it is not visible to the caller. */
  findTemplate(scope: TemplateScope, templateId: string): Promise<SummaryTemplate | null>;
  createTemplate(scope: TemplateScope, draft: SummaryTemplateDraft): Promise<SummaryTemplate>;
  /**
   * Stores the draft as the next version of an existing user template. `null`
   * when the caller owns no template with that id.
   */
  updateTemplate(
    scope: TemplateScope,
    templateId: string,
    draft: SummaryTemplateDraft,
  ): Promise<SummaryTemplate | null>;
  /** Removes every version of a user template. `false` when the caller owns none. */
  deleteTemplate(scope: TemplateScope, templateId: string): Promise<boolean>;
  /**
   * The caller's default template, or `null` when they have chosen none — or
   * when the template they chose no longer exists.
   */
  findDefaultTemplateId(scope: TemplateScope): Promise<string | null>;
  /**
   * Makes one of the caller's own templates their default. `false` when they own
   * no template with that id, so the caller can answer 404 without a second read.
   */
  setDefaultTemplate(scope: TemplateScope, templateId: string): Promise<boolean>;
  /** Drops the caller's default, which puts them back on the system template. */
  clearDefaultTemplate(scope: TemplateScope): Promise<void>;
  close(): Promise<void>;
}

/** Builds the stored document from a draft. The server owns id, version and scope. */
export function templateFromDraft(
  draft: SummaryTemplateDraft,
  identity: { id: string; version: number },
): SummaryTemplate {
  return SummaryTemplateSchema.parse({
    id: identity.id,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    name: draft.name,
    version: identity.version,
    scope: "user",
    basedOn: draft.basedOn ?? null,
    // A template that inherits speaks entirely in overrides, so its own section
    // list is dropped rather than stored to be ignored later.
    sections: draft.basedOn ? [] : draft.sections,
    overrides: draft.overrides,
    options: draft.options,
  });
}

export class PostgresSummaryTemplateStore implements SummaryTemplateStore {
  private readonly sql: postgres.Sql;

  constructor(connectionString: string, options: postgres.Options<Record<string, never>> = {}) {
    this.sql = postgres(connectionString, { max: 2, ...options });
  }

  /**
   * Visibility follows ADR-001: the system template belongs to everybody, a user
   * template only to the user who created it, inside their tenant. The predicate
   * is part of the query rather than a check afterwards, so another user's
   * template matches no row instead of being filtered out of a result that
   * briefly held it.
   */
  async listTemplates(scope: TemplateScope): Promise<SummaryTemplate[]> {
    try {
      const rows = await this.sql<{ template: unknown }[]>`
        SELECT DISTINCT ON (id) template
          FROM summary_templates
         WHERE scope = 'system'
            OR (scope = 'user' AND tenant_id = ${scope.tenantId} AND user_id = ${scope.userId})
         ORDER BY id, version DESC
      `;
      return rows
        .map((row) => parseTemplate(row.template))
        .filter((template): template is SummaryTemplate => template !== null)
        .sort(byScopeThenName);
    } catch (error) {
      // A server that came up before any worker has no templates to show yet.
      // Reporting that as an empty list rather than an error keeps the rest of
      // the screen usable, exactly as the meeting list does for pipeline tables.
      if (isUndefinedTable(error)) return [];
      throw error;
    }
  }

  async findTemplate(scope: TemplateScope, templateId: string): Promise<SummaryTemplate | null> {
    try {
      const rows = await this.sql<{ template: unknown }[]>`
        SELECT template FROM summary_templates
         WHERE id = ${templateId}
           AND (scope = 'system'
                OR (scope = 'user' AND tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}))
         ORDER BY version DESC
         LIMIT 1
      `;
      const row = rows[0];
      return row ? parseTemplate(row.template) : null;
    } catch (error) {
      if (isUndefinedTable(error)) return null;
      throw error;
    }
  }

  async createTemplate(
    scope: TemplateScope,
    draft: SummaryTemplateDraft,
  ): Promise<SummaryTemplate> {
    const template = templateFromDraft(draft, { id: crypto.randomUUID(), version: 1 });
    await this.insert(scope, template);
    return template;
  }

  /**
   * The next version is read and written inside one transaction with the owning
   * row locked, so two concurrent edits produce versions 2 and 3 rather than
   * both claiming 2 and one losing its content to the primary key.
   */
  async updateTemplate(
    scope: TemplateScope,
    templateId: string,
    draft: SummaryTemplateDraft,
  ): Promise<SummaryTemplate | null> {
    try {
      return await this.sql.begin(async (sql) => {
        const rows = await sql<{ version: number }[]>`
          SELECT version FROM summary_templates
           WHERE id = ${templateId}
             AND scope = 'user'
             AND tenant_id = ${scope.tenantId}
             AND user_id = ${scope.userId}
           ORDER BY version DESC
           LIMIT 1
           FOR UPDATE
        `;
        const current = rows[0];
        if (!current) return null;

        const template = templateFromDraft(draft, {
          id: templateId,
          version: current.version + 1,
        });
        await insertWith(sql, scope, template);
        return template;
      });
    } catch (error) {
      if (isUndefinedTable(error)) throw new TemplatesUnavailableError();
      throw error;
    }
  }

  /**
   * Deleting every version is safe because a summary carries a snapshot of the
   * configuration it was produced with (ADR-004 §2) — no existing summary needs
   * the row to stay readable.
   */
  async deleteTemplate(scope: TemplateScope, templateId: string): Promise<boolean> {
    try {
      return await this.sql.begin(async (sql) => {
        const deleted = await sql<{ id: string }[]>`
          DELETE FROM summary_templates
           WHERE id = ${templateId}
             AND scope = 'user'
             AND tenant_id = ${scope.tenantId}
             AND user_id = ${scope.userId}
          RETURNING id
        `;
        if (deleted.length === 0) return false;
        // Deleting the default puts the user back on the system template. The
        // resolution below already treats a dangling pointer that way, so this
        // is not what makes the fallback correct — it keeps the stored state
        // from disagreeing with what is resolved, which is what an operator
        // reading the table would otherwise have to reason about.
        await sql`
          UPDATE user_settings
             SET default_template_id = NULL, updated_at = now()
           WHERE tenant_id = ${scope.tenantId}
             AND user_id = ${scope.userId}
             AND default_template_id = ${templateId}
        `;
        return true;
      });
    } catch (error) {
      if (isUndefinedTable(error)) return false;
      throw error;
    }
  }

  /**
   * The user's default, ignoring a pointer whose template is gone.
   *
   * The `EXISTS` clause is why deleting a template cannot leave the setting in a
   * state that names nothing: an unresolvable default reads as no default, which
   * the routes turn into the system template.
   */
  async findDefaultTemplateId(scope: TemplateScope): Promise<string | null> {
    try {
      const rows = await this.sql<{ default_template_id: string }[]>`
        SELECT s.default_template_id
          FROM user_settings s
         WHERE s.tenant_id = ${scope.tenantId}
           AND s.user_id = ${scope.userId}
           AND EXISTS (
             SELECT 1 FROM summary_templates t
              WHERE t.id = s.default_template_id
                AND t.scope = 'user'
                AND t.tenant_id = ${scope.tenantId}
                AND t.user_id = ${scope.userId}
           )
         LIMIT 1
      `;
      return rows[0]?.default_template_id ?? null;
    } catch (error) {
      if (isUndefinedTable(error)) return null;
      throw error;
    }
  }

  /**
   * Stores the choice, but only for a template the caller actually owns.
   *
   * Ownership is checked as part of the same statement rather than beforehand,
   * so another user's template id cannot be written into this user's settings by
   * winning a race against a separate check.
   */
  async setDefaultTemplate(scope: TemplateScope, templateId: string): Promise<boolean> {
    try {
      const rows = await this.sql<{ tenant_id: string }[]>`
        INSERT INTO user_settings (tenant_id, user_id, default_template_id)
        SELECT ${scope.tenantId}, ${scope.userId}, ${templateId}
         WHERE EXISTS (
           SELECT 1 FROM summary_templates t
            WHERE t.id = ${templateId}
              AND t.scope = 'user'
              AND t.tenant_id = ${scope.tenantId}
              AND t.user_id = ${scope.userId}
         )
        ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET default_template_id = EXCLUDED.default_template_id, updated_at = now()
        RETURNING tenant_id
      `;
      return rows.length > 0;
    } catch (error) {
      if (isUndefinedTable(error)) throw new TemplatesUnavailableError();
      throw error;
    }
  }

  async clearDefaultTemplate(scope: TemplateScope): Promise<void> {
    try {
      await this.sql`
        UPDATE user_settings
           SET default_template_id = NULL, updated_at = now()
         WHERE tenant_id = ${scope.tenantId}
           AND user_id = ${scope.userId}
      `;
    } catch (error) {
      // Nothing was ever stored, so there is nothing to clear.
      if (isUndefinedTable(error)) return;
      throw error;
    }
  }

  private async insert(scope: TemplateScope, template: SummaryTemplate): Promise<void> {
    try {
      await insertWith(this.sql, scope, template);
    } catch (error) {
      if (isUndefinedTable(error)) throw new TemplatesUnavailableError();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

async function insertWith(
  sql: postgres.Sql | postgres.TransactionSql,
  scope: TemplateScope,
  template: SummaryTemplate,
): Promise<void> {
  await sql`
    INSERT INTO summary_templates (
      id, version, schema_version, name, scope, tenant_id, user_id, based_on, template
    ) VALUES (
      ${template.id}, ${template.version}, ${template.schemaVersion}, ${template.name},
      ${template.scope}, ${scope.tenantId}, ${scope.userId}, ${template.basedOn},
      ${sql.json(template as unknown as postgres.JSONValue)}
    )
  `;
}

/** System template first, then the user's own by name — a stable order for the list screen. */
export function byScopeThenName(a: SummaryTemplate, b: SummaryTemplate): number {
  if (a.scope !== b.scope) return a.scope === "system" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * A stored template that no longer matches the schema is reported as absent
 * rather than failing the whole list: one unreadable row must not take the
 * template screen offline.
 */
function parseTemplate(value: unknown): SummaryTemplate | null {
  const parsed = SummaryTemplateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE;
}
