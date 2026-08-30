// Creates the suite's development users against the running stack's database.
//
// SPIKE NOTE — this script exists because the Keycloak realm JSON does not. The realm carried its
// dev users as data, imported on first start, so the suite needed nothing here. With an
// in-process provider there is no import path at all: accounts exist only because something
// creates them, so the suite creates them.
//
// It talks to the database rather than to the API on purpose: `tenantId` is not settable through
// the public sign-up endpoint (a user who could pick their own tenant could read another
// tenant's data), so assigning it needs the same server-side path production provisioning would.
import { Pool } from "pg";
import { createQuorumAuth, provisionUser } from "@quorum/server";

const databaseUrl = process.env.DATABASE_URL;
const secret = process.env.AUTH_SECRET;
const baseURL = process.env.AUTH_BASE_URL;
if (!databaseUrl || !secret || !baseURL) {
  throw new Error("seed-users needs DATABASE_URL, AUTH_SECRET and AUTH_BASE_URL");
}

const users = [
  { email: "dev.alice@acme.dev.invalid", name: "dev.alice", tenantId: "tenant-acme" },
  { email: "dev.bob@acme.dev.invalid", name: "dev.bob", tenantId: "tenant-acme" },
  { email: "dev.carol@globex.dev.invalid", name: "dev.carol", tenantId: "tenant-globex" },
];

const pool = new Pool({ connectionString: databaseUrl });
const auth = createQuorumAuth({
  secret,
  baseURL,
  trustedOrigins: [baseURL],
  database: pool,
});

try {
  for (const user of users) {
    await provisionUser(auth, { ...user, password: "dev-password-1234" });
    console.log(`[e2e] seeded ${user.email} in ${user.tenantId}`);
  }
} finally {
  await pool.end();
}
