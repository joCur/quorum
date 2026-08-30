import { getMigrations } from "better-auth/db/migration";
import type { QuorumAuth, QuorumAuthOptions } from "./instance.js";
import { quorumAuthOptions } from "./instance.js";

/**
 * Creates better-auth's own tables (`user`, `session`, `account`, `verification`).
 *
 * WHERE THIS FITS THE EXISTING SPLIT OWNERSHIP: the repository already has three migration owners
 * on one database — the API owns the meeting tables (`PostgresMeetingStore.migrate()`), the worker
 * owns `summary_templates`, and pg-boss owns its own schema. This adds a fourth, and it is the
 * only one whose migration plan is *derived* rather than written down: better-auth diffs its
 * configured schema against the live database. The upside is that adding a plugin adds its tables
 * automatically; the downside is that a schema change is invisible in a pull request diff, which
 * is precisely the property ADR-006 bought with the versioned Keycloak realm JSON.
 *
 * The auth tables land in the same database and the same schema as the domain tables, unlike
 * Keycloak, which had its own database and its own user. Isolating them again would mean a second
 * connection string; the report notes it as an open point rather than pretending it is solved.
 */
export async function migrateAuthSchema(options: QuorumAuthOptions): Promise<void> {
  const { runMigrations } = await getMigrations(quorumAuthOptions(options));
  await runMigrations();
}

/** Prints the SQL better-auth would run, for review before it runs it. */
export async function compileAuthMigrations(options: QuorumAuthOptions): Promise<string> {
  const { compileMigrations } = await getMigrations(quorumAuthOptions(options));
  return compileMigrations();
}

export interface ProvisionedUser {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly tenantId: string;
  readonly roles?: readonly string[];
}

/**
 * Creates a user with a tenant, or updates the tenant of one that already exists.
 *
 * This is the replacement for the realm JSON's `users` block, and it is the honest measure of what
 * disappeared with Keycloak: there is no admin console and no import file, so *every* account has
 * to be created by something we write. Here that something is the dev/E2E seeder; in production it
 * would be an invitation flow that does not exist yet in either world (see the production-auth
 * issue).
 *
 * `tenantId` is set through the adapter rather than through sign-up on purpose — the field is
 * `input: false`, so the public endpoint cannot be talked into assigning a tenant.
 */
export async function provisionUser(auth: QuorumAuth, user: ProvisionedUser): Promise<string> {
  const context = await auth.$context;

  let userId: string;
  try {
    const created = await auth.api.signUpEmail({
      body: { email: user.email, password: user.password, name: user.name },
    });
    userId = created.user.id;
  } catch (error) {
    const existing = await context.adapter.findOne<{ id: string }>({
      model: "user",
      where: [{ field: "email", value: user.email }],
    });
    if (existing === null) throw error;
    userId = existing.id;
  }

  await context.adapter.update({
    model: "user",
    where: [{ field: "id", value: userId }],
    update: {
      tenantId: user.tenantId,
      roles: (user.roles ?? ["quorum-user"]).join(","),
    },
  });

  return userId;
}
