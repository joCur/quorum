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
  /** Seconds of recorded audio after which the server finalizes a recording itself. Default 4 h. */
  RECORDING_MAX_RECORDED_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 60 * 60),
  /** Wall-clock seconds a session may stay open, pauses included. Default 12 h. */
  RECORDING_MAX_SESSION_LIFETIME_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 60 * 60),
  /** Wall-clock seconds a single pause may last before the session is finalized. Default 2 h. */
  RECORDING_MAX_PAUSE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60),
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

  // --- Authentication (SPIKE: better-auth runs in this process; there is no external issuer) ---
  /**
   * Signing secret for session tokens and cookies.
   *
   * There is no key rotation story behind this: rotating it invalidates every session at once,
   * where Keycloak rotated realm signing keys without signing anybody out. The minimum length is
   * enforced here because this one value is now what stands between a leaked environment file and
   * every account in the deployment.
   */
  AUTH_SECRET: z.string().min(32),
  /** Public base URL the auth endpoints are reachable under, e.g. `https://app.example.com`. */
  AUTH_BASE_URL: z.string().url(),
  /** Comma-separated browser origins allowed to call the auth endpoints. */
  /** Issuer that browser-obtained tokens actually carry, when it differs from the internal one. */
  AUTH_TRUSTED_ORIGINS: z.string().default(""),
  /** Session lifetime in seconds. Default 8 h. */
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 60 * 60),
  /** Auth-endpoint requests per window per caller. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  /** Length of that window, in seconds. */
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Sign-in attempts per window per caller — the brute-force bound. */
  AUTH_SIGN_IN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return ServerConfigSchema.parse(env);
}

/** The limits as the enforcement sites want them, derived from the flat environment config. */
export function resolveUserLimits(config: ServerConfig): UserLimits {
  return {
    maxRecordedSeconds: config.RECORDING_MAX_RECORDED_SECONDS,
    maxSessionLifetimeSeconds: config.RECORDING_MAX_SESSION_LIFETIME_SECONDS,
    maxPauseSeconds: config.RECORDING_MAX_PAUSE_SECONDS,
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

/** Everything the in-process auth instance needs, derived from the flat environment config. */
export interface AuthConfig {
  readonly secret: string;
  readonly baseURL: string;
  /** Origins allowed to call the auth endpoints; the base URL is always included. */
  readonly trustedOrigins: readonly string[];
  readonly sessionTtlSeconds: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowSeconds: number;
  readonly signInRateLimitMax: number;
}

export function resolveAuthConfig(config: ServerConfig): AuthConfig {
  const configured = config.AUTH_TRUSTED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    secret: config.AUTH_SECRET,
    baseURL: config.AUTH_BASE_URL,
    trustedOrigins: [...new Set([config.AUTH_BASE_URL, ...configured])],
    sessionTtlSeconds: config.AUTH_SESSION_TTL_SECONDS,
    rateLimitMax: config.AUTH_RATE_LIMIT_MAX,
    rateLimitWindowSeconds: config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    signInRateLimitMax: config.AUTH_SIGN_IN_RATE_LIMIT_MAX,
  };
}
