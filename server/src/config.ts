import { z } from "zod";

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const environmentSchema = z.object({
  SERVER_HOST: z.string().min(1).default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().positive().max(65535).default(8080),
  LOG_LEVEL: z.enum(logLevels).default("info"),

  /** Issuer used for discovery and JWKS retrieval; inside compose this is the internal URL. */
  OIDC_ISSUER_URL: z.string().url(),
  /** Issuer that browser-obtained tokens actually carry, when it differs from the internal one. */
  OIDC_PUBLIC_ISSUER_URL: z.string().url().optional(),
  /** Explicit JWKS endpoint; defaults to the Keycloak convention derived from the issuer. */
  OIDC_JWKS_URI: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default("quorum-api"),
  OIDC_TENANT_CLAIM: z.string().min(1).default("tenant_id"),
});

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof logLevels)[number];
  readonly oidc: {
    /** Issuer used to reach Keycloak (discovery, JWKS). */
    readonly issuer: string;
    /** All issuers accepted in the `iss` claim, deduplicated. */
    readonly acceptedIssuers: readonly string[];
    readonly jwksUri: string | undefined;
    readonly audience: string;
    readonly tenantClaim: string;
  };
}

/**
 * Reads and validates the server configuration. Everything is environment-driven so the same
 * image runs in compose and in production without a code change.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server configuration — ${details}`);
  }
  const value = parsed.data;

  const acceptedIssuers = [
    ...new Set([value.OIDC_ISSUER_URL, value.OIDC_PUBLIC_ISSUER_URL]),
  ].filter((issuer): issuer is string => issuer !== undefined);

  return {
    host: value.SERVER_HOST,
    port: value.SERVER_PORT,
    logLevel: value.LOG_LEVEL,
    oidc: {
      issuer: value.OIDC_ISSUER_URL,
      acceptedIssuers,
      jwksUri: value.OIDC_JWKS_URI,
      audience: value.OIDC_AUDIENCE,
      tenantClaim: value.OIDC_TENANT_CLAIM,
    },
  };
}
