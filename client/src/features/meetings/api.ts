import { MeetingDetailSchema, MeetingListSchema, MeetingSchema } from "@quorum/shared";
import type { Meeting, MeetingDetail, RenameMeetingRequest } from "@quorum/shared";
import { apiUrl } from "@/env";
import { reportUnauthorized } from "@/features/auth/session-expiry";

/**
 * Client for the meeting API.
 *
 * Responses are parsed with the shared schemas rather than cast: `shared/src/` is the contract
 * both sides compile against, so a server that drifts from it fails here, loudly, instead of
 * rendering something half-defined.
 */

/** An API call that did not succeed, carrying the machine-readable code the server sent. */
export class MeetingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MeetingApiError";
  }

  /** True when the meeting is gone or was never the caller's — the UI treats both the same. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * True when the server refused the request for lack of a valid token.
   *
   * Screens read it to stay quiet: the shared session-expiry path is already renewing the token or
   * routing into the login flow, and a load-error message would name the wrong problem.
   */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

interface RequestOptions {
  accessToken: string;
  signal?: AbortSignal | undefined;
}

async function call(
  path: string,
  options: RequestOptions & { method?: string; body?: string },
): Promise<Response> {
  const response = await fetch(apiUrl(path), {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await toApiError(response);
  return response;
}

/**
 * Turns a failing response into the error the UI works with.
 *
 * Every API client in this app funnels its failures through here, which is what makes the 401
 * handling a single path: an expired session is reported once, from one place, no matter which
 * screen happened to be loading.
 */
export async function toApiError(response: Response): Promise<MeetingApiError> {
  if (response.status === 401) reportUnauthorized();
  // A failing response is not guaranteed to carry our error shape — a proxy may answer with
  // HTML — so the body is best-effort and the status is what the UI can always rely on.
  let code = "request_failed";
  let message = response.statusText;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // Keep the status-derived defaults.
  }
  return new MeetingApiError(response.status, code, message);
}

export interface ListMeetingsParams extends RequestOptions {
  /** Case-insensitive title search, passed to the server so it also covers unloaded pages. */
  search?: string | undefined;
}

export async function listMeetings(params: ListMeetingsParams): Promise<Meeting[]> {
  const query = params.search ? `?q=${encodeURIComponent(params.search)}` : "";
  const response = await call(`/api/meetings${query}`, params);
  return MeetingListSchema.parse(await response.json()).meetings;
}

export async function fetchMeeting(
  meetingId: string,
  options: RequestOptions,
): Promise<MeetingDetail> {
  const response = await call(`/api/meetings/${meetingId}`, options);
  return MeetingDetailSchema.parse(await response.json());
}

export async function deleteMeeting(meetingId: string, options: RequestOptions): Promise<void> {
  await call(`/api/meetings/${meetingId}`, { ...options, method: "DELETE" });
}

/**
 * Renames a meeting, or clears its name when the title is empty.
 *
 * Clearing is a real request rather than a no-op: it returns the meeting to unnamed, the state in
 * which a later summary may suggest a name of its own.
 */
export async function renameMeeting(
  meetingId: string,
  title: string,
  options: RequestOptions,
): Promise<Meeting> {
  const body: RenameMeetingRequest = { title };
  const response = await call(`/api/meetings/${meetingId}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return MeetingSchema.parse(await response.json());
}

/** URL of a meeting's audio stream. The request itself carries the access token. */
export function meetingAudioUrl(meetingId: string): string {
  return apiUrl(`/api/meetings/${meetingId}/audio`);
}
