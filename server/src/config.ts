import { z } from "zod";

/** Environment configuration — names match `docker-compose.yml` / `.env.example`. */
export const ServerConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  /** Server-side encryption algorithm requested per object (ADR-001). */
  S3_SSE: z.string().default("AES256"),
  /**
   * Development-only fallback that reads tenant and user from request headers instead of from a
   * validated access token. Off unless explicitly enabled.
   */
  RECORDING_ALLOW_HEADER_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /** Issuer used for discovery and JWKS retrieval; inside compose the container-internal URL. */
  OIDC_ISSUER_URL: z.string().url(),
  /** Issuer that browser-obtained tokens actually carry, when it differs from the internal one. */
  OIDC_PUBLIC_ISSUER_URL: z.string().url().optional(),
  /** Explicit JWKS endpoint; defaults to the Keycloak convention derived from the issuer. */
  OIDC_JWKS_URI: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default("quorum-api"),
  OIDC_TENANT_CLAIM: z.string().min(1).default("tenant_id"),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return ServerConfigSchema.parse(env);
}

/** Everything the token verifier needs, derived from the flat environment configuration. */
export interface OidcConfig {
  /** Issuer used to reach Keycloak (discovery, JWKS). */
  readonly issuer: string;
  /** All issuers accepted in the `iss` claim, deduplicated. */
  readonly acceptedIssuers: readonly string[];
  readonly jwksUri: string | undefined;
  readonly audience: string;
  readonly tenantClaim: string;
}

export function resolveOidcConfig(config: ServerConfig): OidcConfig {
  const acceptedIssuers = [
    ...new Set([config.OIDC_ISSUER_URL, config.OIDC_PUBLIC_ISSUER_URL]),
  ].filter((issuer): issuer is string => issuer !== undefined);

  return {
    issuer: config.OIDC_ISSUER_URL,
    acceptedIssuers,
    jwksUri: config.OIDC_JWKS_URI,
    audience: config.OIDC_AUDIENCE,
    tenantClaim: config.OIDC_TENANT_CLAIM,
  };
}
