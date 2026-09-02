/**
 * The orchestrator (`scripts/run.mjs`) exports these before starting Playwright. Running a single
 * spec by hand against a stack that is already up needs no re-declaring either: the credentials
 * come from `.stack.env`, and the ports from the file that run wrote for its compose project, so
 * `E2E_PROJECT=<name> playwright test <spec>` is enough.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Credentials the orchestrator generated for this stack. Reading the file directly is what lets a
 * single spec run against a stack that is already up, without re-exporting anything by hand.
 */
const generated = readStackCredentials();

/**
 * The host ports that stack publishes. They are picked per run, so there is no default worth
 * guessing: without a project name, only the exported `E2E_*` URLs can say where the stack is.
 */
const ports = readStackPorts();

function readStackPorts(): Record<string, string> {
  const project = process.env["E2E_PROJECT"] ?? process.env["E2E_COMPOSE_PROJECT"];
  if (project === undefined || project === "") return {};
  const path = resolve(e2eDir, `.ports.${project}.json`);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

function url(portName: string, host = "localhost"): string | undefined {
  const port = ports[portName];
  return port === undefined ? undefined : `http://${host}:${port}`;
}

function readStackCredentials(): Record<string, string> {
  const path = resolve(e2eDir, ".stack.env");
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

function read(name: string, fallback: string | undefined): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback === undefined) {
    throw new Error(
      `${name} is not set and this stack's ports are unknown. Run the suite through ` +
        `\`pnpm run e2e\`, or name the running stack with E2E_PROJECT so its ports can be read.`,
    );
  }
  return fallback;
}

export const stackEnv = {
  clientUrl: read("E2E_CLIENT_URL", url("CLIENT_PORT")),
  apiUrl: read("E2E_API_URL", url("API_PORT")),
  keycloakUrl: read("E2E_KEYCLOAK_URL", url("KEYCLOAK_PORT")),
  /** The development mail relay's HTTP API — where account mail can be read back. */
  mailpitUrl: read("E2E_MAILPIT_URL", url("MAILPIT_UI_PORT")),
  realm: read("E2E_KEYCLOAK_REALM", "quorum"),
  /** Public browser client — Authorization Code + PKCE, used by the app itself. */
  pwaClientId: read("E2E_OIDC_CLIENT_ID", "quorum-pwa"),
  /** Development-only password-grant client, used to obtain tokens outside the browser. */
  cliClientId: read("E2E_OIDC_CLI_CLIENT_ID", "quorum-dev-cli"),
  databaseUrl: read(
    "E2E_DATABASE_URL",
    ports["POSTGRES_PORT"] === undefined
      ? undefined
      : `postgres://quorum:${generated["POSTGRES_PASSWORD"] ?? ""}@127.0.0.1:${ports["POSTGRES_PORT"]}/quorum`,
  ),
  s3: {
    endpoint: read("E2E_S3_ENDPOINT", url("MINIO_PORT", "127.0.0.1")),
    region: read("E2E_S3_REGION", "us-east-1"),
    bucket: read("E2E_S3_BUCKET", "recordings"),
    accessKeyId: read("E2E_S3_ACCESS_KEY", "quorum-e2e"),
    secretAccessKey: read("E2E_S3_SECRET_KEY", generated["MINIO_ROOT_PASSWORD"] ?? ""),
  },
  /** "mock" points the worker at a stub transcription endpoint; "real" uses CPU Whisper. */
  whisperMode: read("E2E_WHISPER", "mock"),
  /**
   * The stub backend the orchestrator runs beside the stack. It serves summaries in both Whisper
   * modes, and a control endpoint a test can use to make the next transcription fail.
   */
  mockBackendUrl: read("E2E_MOCK_BACKEND_URL", url("MOCK_WHISPER_PORT", "127.0.0.1")),
} as const;

/** Development fixtures from the imported realm — deliberately not secrets. */
export const devUsers = {
  alice: { username: "dev.alice", password: "dev-password", tenantId: "tenant-acme" },
  bob: { username: "dev.bob", password: "dev-password", tenantId: "tenant-acme" },
  carol: { username: "dev.carol", password: "dev-password", tenantId: "tenant-globex" },
} as const;

export type DevUser = (typeof devUsers)[keyof typeof devUsers];
