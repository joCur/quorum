/**
 * Everything the tests need to reach the running stack.
 *
 * The orchestrator (`scripts/run.mjs`) exports these before starting Playwright. Every value also
 * has a default matching `e2e.env`, and the generated credentials are read from `.stack.env`, so a
 * single spec can be run against a stack that is already up without re-declaring anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Credentials the orchestrator generated for this stack. Reading the file directly is what lets a
 * single spec run against a stack that is already up, without re-exporting anything by hand.
 */
const generated = readStackCredentials();

function readStackCredentials(): Record<string, string> {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".stack.env");
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator !== -1) values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function read(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export const stackEnv = {
  clientUrl: read("E2E_CLIENT_URL", "http://localhost:4173"),
  apiUrl: read("E2E_API_URL", "http://localhost:8090"),
  keycloakUrl: read("E2E_KEYCLOAK_URL", "http://localhost:8091"),
  /** The development mail relay's HTTP API — where account mail can be read back. */
  mailpitUrl: read("E2E_MAILPIT_URL", "http://localhost:8125"),
  realm: read("E2E_KEYCLOAK_REALM", "quorum"),
  /** Public browser client — Authorization Code + PKCE, used by the app itself. */
  pwaClientId: read("E2E_OIDC_CLIENT_ID", "quorum-pwa"),
  /** Development-only password-grant client, used to obtain tokens outside the browser. */
  cliClientId: read("E2E_OIDC_CLI_CLIENT_ID", "quorum-dev-cli"),
  databaseUrl: read(
    "E2E_DATABASE_URL",
    `postgres://quorum:${generated["POSTGRES_PASSWORD"] ?? ""}@127.0.0.1:55433/quorum`,
  ),
  s3: {
    endpoint: read("E2E_S3_ENDPOINT", "http://127.0.0.1:9010"),
    region: read("E2E_S3_REGION", "us-east-1"),
    bucket: read("E2E_S3_BUCKET", "recordings"),
    accessKeyId: read("E2E_S3_ACCESS_KEY", "quorum-e2e"),
    secretAccessKey: read("E2E_S3_SECRET_KEY", generated["MINIO_ROOT_PASSWORD"] ?? ""),
  },
  /** "mock" points the worker at a stub transcription endpoint; "real" uses CPU Whisper. */
  whisperMode: read("E2E_WHISPER", "mock"),
} as const;

/** Development fixtures from the imported realm — deliberately not secrets. */
export const devUsers = {
  alice: { username: "dev.alice", password: "dev-password", tenantId: "tenant-acme" },
  bob: { username: "dev.bob", password: "dev-password", tenantId: "tenant-acme" },
  carol: { username: "dev.carol", password: "dev-password", tenantId: "tenant-globex" },
} as const;

export type DevUser = (typeof devUsers)[keyof typeof devUsers];
