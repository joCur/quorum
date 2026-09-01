import { Agent, FormData as UndiciFormData, fetch as undiciFetch, type Dispatcher } from "undici";

/**
 * Node's built-in `fetch` applies undici's default `headersTimeout` of 300
 * seconds, and that timer runs regardless of any `AbortSignal` the caller
 * installed. A backend that computes first and answers afterwards — a Whisper
 * server transcribing an hour of audio, a chat completion requested without
 * streaming — sends its response headers only when it is done, so every such
 * request died after exactly five minutes with `Headers Timeout Error`, no
 * matter what timeout the deployment had configured.
 *
 * The fix is to run these requests through an undici dispatcher whose timeouts
 * are derived from the configured one instead of from a library default. Because
 * the built-in `fetch` of the running Node version rejects a dispatcher built by
 * a different undici copy, the request has to go through undici's own `fetch`
 * as well; nothing else about the call changes.
 */

/**
 * Added on top of the configured timeout, so the caller's `AbortController` is
 * always the limit that fires first and the error mapping stays the one the
 * clients were written for: an exceeded budget surfaces as an abort, never as a
 * transport-level timeout that reads like a backend outage.
 */
export const TIMEOUT_HEADROOM_MS = 30_000;

/**
 * How long the response body may go quiet before the transport gives up.
 *
 * Deliberately a small constant rather than something derived from the request
 * budget, because `bodyTimeout` is an idle timer between chunks, not a total for
 * the body: raising it never buys a slow download more time, it only widens the
 * window in which a backend that died mid-body keeps the attempt alive. Deriving
 * it from a 30-minute budget would stretch that window from undici's 300 s
 * default to half an hour — the opposite of the intent. Once a backend has
 * computed its answer the bytes follow promptly, so a minute of complete silence
 * already means something is wrong. The whole-request limit is the caller's
 * abort signal, which spans the body read too.
 */
export const BODY_IDLE_TIMEOUT_MS = 60_000;

export interface TransportTimeouts {
  /** How long the backend may take to send response headers. */
  headersTimeout: number;
  /** How long a gap between response body chunks may be. */
  bodyTimeout: number;
}

/** Transport timeouts for a request whose own budget is `timeoutMs`. */
export function transportTimeoutsFor(timeoutMs: number): TransportTimeouts {
  return {
    headersTimeout: timeoutMs + TIMEOUT_HEADROOM_MS,
    bodyTimeout: BODY_IDLE_TIMEOUT_MS,
  };
}

/**
 * A `fetch` for one client instance: same signature as the global one, but the
 * request is dispatched over a connection pool that waits as long as the
 * configuration says. The pool is created once and reused, which also keeps
 * connections warm across jobs.
 *
 * `createDispatcher` exists so a test can read the timeouts the pool was built
 * with without opening a socket.
 */
export function createFetchWithTimeouts(
  timeoutMs: number,
  createDispatcher: (timeouts: TransportTimeouts) => Dispatcher = (timeouts) => new Agent(timeouts),
): typeof fetch {
  const dispatcher = createDispatcher(transportTimeoutsFor(timeoutMs));
  const fetchWithTimeouts = (
    input: Parameters<typeof undiciFetch>[0],
    init?: Parameters<typeof undiciFetch>[1],
  ) => undiciFetch(input, { ...init, dispatcher });
  // undici ships its own DOM-shaped `fetch` declarations; the values are the
  // ones the callers already handle, only the type identities differ.
  return fetchWithTimeouts as unknown as typeof fetch;
}

/**
 * A multipart body for a request sent through `createFetchWithTimeouts`.
 *
 * It has to come from here rather than from the global `FormData`: undici
 * recognizes only its own class, and a foreign one is encoded as the string
 * `"[object FormData]"` — a request that succeeds while carrying no audio at
 * all. The value behaves like the global `FormData` in every other respect.
 */
export function createMultipartBody(): FormData {
  return new UndiciFormData() as unknown as FormData;
}
