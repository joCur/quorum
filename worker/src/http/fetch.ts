import { Agent, fetch as undiciFetch } from "undici";

/**
 * HTTP timeouts for a backend that thinks before it answers.
 *
 * `fetch` runs on undici, and undici's defaults assume an API that replies
 * promptly: `headersTimeout` is 300 s, counted from the moment the request body
 * has been written. A transcription backend sends no response headers until the
 * transcript is finished, so any run longer than five minutes was killed with
 * `Headers Timeout Error` no matter how generous the configured timeout was —
 * the abort signal built from that configuration never became the binding
 * limit. Deriving both undici timeouts from the same configured value makes the
 * documented number the real one, and leaves the abort signal as the wall clock
 * for a backend that answers with headers and then dribbles bytes forever.
 */
export interface RequestTimeoutOptions {
  /** How long the backend may think before it sends response headers. */
  headersTimeout: number;
  /** How long a gap between response body chunks may last. */
  bodyTimeout: number;
}

/** The undici timeouts a whole-request budget of `timeoutMs` implies. */
export function requestTimeoutOptions(timeoutMs: number): RequestTimeoutOptions {
  return { headersTimeout: timeoutMs, bodyTimeout: timeoutMs };
}

/**
 * The `fetch` these dispatchers belong to, and the dispatcher type its request
 * options accept.
 *
 * Both are the ambient Node types on purpose. Node bundles its own copy of
 * undici — a different major on every Node line — and the two copies ship two
 * structurally incompatible declarations of the same objects. Typing the
 * clients against the ambient ones keeps a second `Dispatcher` type out of the
 * rest of the worker, and lets a test keep substituting a plain `fetch`.
 */
export type FetchImpl = typeof fetch;
export type Dispatcher = NonNullable<RequestInit["dispatcher"]>;

/**
 * A dispatcher that waits `timeoutMs` for a slow backend. Connection setup keeps
 * undici's short default: a backend that cannot be reached at all should fail
 * fast and be retried, not sit on the job's whole budget.
 */
export function createTimeoutDispatcher(timeoutMs: number): Dispatcher {
  return new Agent(requestTimeoutOptions(timeoutMs)) as unknown as Dispatcher;
}

/**
 * undici's own `fetch`, which is the one that accepts these dispatchers: the
 * copy of undici Node bundles rejects a dispatcher built by the package copy
 * outright, with `UND_ERR_INVALID_ARG`. Going through the package for both ends
 * keeps request stack and dispatcher on one version whatever Node the worker
 * runs on.
 *
 * One consequence deserves its own warning: a multipart body must then be built
 * with undici's `FormData`. Handing this `fetch` a global `FormData` does not
 * fail — it stringifies the object into a `text/plain` body.
 */
export const timeoutAwareFetch = undiciFetch as unknown as FetchImpl;

/**
 * What actually went wrong, for the log line and the job's error message.
 *
 * A rejected `fetch` says no more than "fetch failed"; the reason — a refused
 * connection, a DNS miss, `Headers Timeout Error` — hangs one level below in
 * `cause`. Flattening the two keeps a failure diagnosable from a single line.
 */
export function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause && cause !== error.message ? `${error.message}: ${cause}` : error.message;
}
