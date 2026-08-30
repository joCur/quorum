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

/**
 * Development fixtures — deliberately not secrets.
 *
 * SPIKE: these used to come from the committed realm JSON, which the Keycloak container imported
 * on first start. There is no import file any more, so `e2e/scripts/seed-users.mjs` creates them
 * against the running API before the suite starts. The password is longer than it was because the
 * server enforces a 12-character minimum; Keycloak's realm had no policy configured at all.
 */
export const devUsers = {
  alice: {
    email: "dev.alice@acme.dev.invalid",
    name: "dev.alice",
    password: "dev-password-1234",
    tenantId: "tenant-acme",
  },
  bob: {
    email: "dev.bob@acme.dev.invalid",
    name: "dev.bob",
    password: "dev-password-1234",
    tenantId: "tenant-acme",
  },
  carol: {
    email: "dev.carol@globex.dev.invalid",
    name: "dev.carol",
    password: "dev-password-1234",
    tenantId: "tenant-globex",
  },
} as const;

export type DevUser = (typeof devUsers)[keyof typeof devUsers];
