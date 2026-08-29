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
  /** OIDC issuer, e.g. https://auth.example.com/realms/quorum */
  VITE_OIDC_ISSUER_URL: z.string().url(),
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

/** Same as `apiUrl`, converted to the matching WebSocket scheme. */
export function webSocketUrl(path: string): string {
  const url = new URL(apiUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
