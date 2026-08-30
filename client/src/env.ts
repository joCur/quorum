import { z } from "zod";

/**
 * Build-time configuration.
 *
 * A self-hosted deployment must be able to point the app at its own API, so the value comes from
 * a `VITE_*` variable rather than being hard-coded. Parsing it here means a bad value fails
 * loudly at startup rather than halfway through a request.
 */
const EnvSchema = z.object({
  /** Base URL of the Quorum API. Empty means "same origin as the app". */
  VITE_API_BASE_URL: z.string().default(""),
  /*
   * SPIKE: the three OIDC variables are gone. Authentication now lives at `/api/auth` on the API
   * the app already talks to, so there is nothing left to point the app at — one fewer piece of
   * build-time configuration a self-hoster has to get right, and one fewer way to get it wrong.
   */
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
