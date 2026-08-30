import { z } from "zod";
import type { UserLimits } from "./limits.js";

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

  // --- Abuse and cost protection for the recording endpoint (see `recording/limits.ts`) ---
  /** Wall-clock seconds after which the server finalizes a recording itself. Default 4 h. */
  RECORDING_MAX_SESSION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 60 * 60),
  /** Recording sessions one user may have open at the same time. */
  RECORDING_MAX_PARALLEL_SESSIONS: z.coerce.number().int().positive().default(3),
  /** Sustained chunk frames per second per connection. A live recording sends 0.5–1. */
  RECORDING_MAX_CHUNKS_PER_SECOND: z.coerce.number().positive().default(20),
  /** Sustained bytes per second per connection. Live Opus is around 4 KiB/s. */
  RECORDING_MAX_BYTES_PER_SECOND: z.coerce
    .number()
    .positive()
    .default(4 * 1024 * 1024),
  /** Seconds' worth of both rates a connection may spend at once — the reconnect replay. */
  RECORDING_RATE_BURST_SECONDS: z.coerce.number().positive().default(10),
  /** Stored audio one user may hold, in bytes. Default 50 GiB, roughly 3,000 hours of Opus. */
  QUOTA_STORAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024 * 1024),
  /** Seconds a user may record per calendar month (UTC). Default 100 h. */
  QUOTA_MONTHLY_RECORDED_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 60 * 60),
  /** Chunks between two usage writes — what makes the quotas survive a crash. */
  QUOTA_USAGE_FLUSH_CHUNKS: z.coerce.number().int().positive().default(64),
  /** REST requests one user may make per window. Default 300. */
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** Length of that window, in seconds. Default 60. */
  API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Regenerate requests per window — the one route that costs a model call. Default 10. */
  API_RATE_LIMIT_SUMMARY_MAX: z.coerce.number().int().positive().default(10),

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

/** The limits as the enforcement sites want them, derived from the flat environment config. */
export function resolveUserLimits(config: ServerConfig): UserLimits {
  return {
    maxSessionSeconds: config.RECORDING_MAX_SESSION_SECONDS,
    maxParallelSessions: config.RECORDING_MAX_PARALLEL_SESSIONS,
    maxChunksPerSecond: config.RECORDING_MAX_CHUNKS_PER_SECOND,
    maxBytesPerSecond: config.RECORDING_MAX_BYTES_PER_SECOND,
    burstSeconds: config.RECORDING_RATE_BURST_SECONDS,
    maxStorageBytes: config.QUOTA_STORAGE_BYTES,
    maxMonthlyRecordedSeconds: config.QUOTA_MONTHLY_RECORDED_SECONDS,
    usageFlushChunks: config.QUOTA_USAGE_FLUSH_CHUNKS,
    apiRequestsPerWindow: config.API_RATE_LIMIT_MAX,
    apiWindowSeconds: config.API_RATE_LIMIT_WINDOW_SECONDS,
    apiSummaryRequestsPerWindow: config.API_RATE_LIMIT_SUMMARY_MAX,
  };
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
