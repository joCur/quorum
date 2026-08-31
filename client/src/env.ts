import { z } from "zod";

/**
 * Build-time configuration.
 *
 * A self-hosted deployment must be able to point the app at its own API and its
 * own identity provider, so every value comes from `VITE_*` variables and none
 * of them are hard-coded. Parsing them here means a missing issuer URL fails
 * loudly at startup instead of halfway through a sign-in redirect.
 */
const EnvSchema = z.object({
  /** Base URL of the Quorum API. Empty means "same origin as the app". */
  VITE_API_BASE_URL: z.string().default(""),
  /**
   * Absolute OIDC issuer, e.g. https://auth.example.com/realms/quorum. Empty means "same origin
   * as the app", with the realm reached under `VITE_OIDC_ISSUER_PATH` — which is what the
   * published client image is built for, because an absolute issuer is deployment-specific and
   * cannot be baked into an image anyone else runs.
   */
  VITE_OIDC_ISSUER_URL: z.union([z.string().url(), z.literal("")]).default(""),
  /** Path of the realm when the issuer is served from the app's own origin. */
  VITE_OIDC_ISSUER_PATH: z.string().default("/realms/quorum"),
  VITE_OIDC_CLIENT_ID: z.string().min(1),
  /** Space-separated scopes requested during the Authorization Code flow. */
  VITE_OIDC_SCOPE: z.string().default("openid profile email"),
});

const parsed = EnvSchema.safeParse(import.meta.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
  throw new Error(
    `Missing or invalid frontend configuration: ${missing}. See client/.env.example.`,
  );
}

export const env = parsed.data;

/** Injected by Vite from the package version (see vite.config.ts). */
export const APP_VERSION = __APP_VERSION__;

/**
 * Absolute URL of an API path. Relative to the app's own origin unless
 * `VITE_API_BASE_URL` names a different one.
 */
export function apiUrl(path: string): string {
  const base = env.VITE_API_BASE_URL || window.location.origin;
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Absolute URL of the OIDC issuer.
 *
 * Same rule as `apiUrl`: an explicit `VITE_OIDC_ISSUER_URL` wins, and otherwise the issuer is on
 * the app's own origin. Resolved lazily rather than at module load, because it reads
 * `window.location` and the value has to be the origin the app is actually being served from.
 */
export function oidcIssuerUrl(): string {
  if (env.VITE_OIDC_ISSUER_URL) return env.VITE_OIDC_ISSUER_URL;
  const path = env.VITE_OIDC_ISSUER_PATH.replace(/\/+$/, "");
  return new URL(path, window.location.origin).toString();
}

/** Same as `apiUrl`, converted to the matching WebSocket scheme. */
export function webSocketUrl(path: string): string {
  const url = new URL(apiUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
