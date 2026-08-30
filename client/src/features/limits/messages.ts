import { LIMIT_ERROR_CODES, type LimitErrorCode } from "@quorum/shared";

/**
 * How a limit refusal is named on screen.
 *
 * The server never sends a sentence, only one of the codes in `shared/src/limits.ts` — in an error
 * body, or in the reason of a WebSocket close frame. This is the single place that turns one into
 * an i18n key, so the recording screen and the meeting screen say the same thing about the same
 * limit, in the user's language.
 *
 * The map is exhaustive over the shared codes by type, so a limit added to the contract cannot
 * reach the UI without copy of its own.
 */
const MESSAGE_KEYS = {
  "limit.session_duration_exceeded": "limits.sessionDuration",
  "limit.session_lifetime_exceeded": "limits.sessionLifetime",
  "limit.pause_duration_exceeded": "limits.pauseDuration",
  "limit.parallel_sessions_exceeded": "limits.parallelSessions",
  "limit.chunk_rate_exceeded": "limits.sendRate",
  "limit.byte_rate_exceeded": "limits.sendRate",
  "limit.storage_quota_exceeded": "limits.storageQuota",
  "limit.monthly_hours_quota_exceeded": "limits.monthlyQuota",
  "limit.request_rate_exceeded": "limits.requestRate",
} as const satisfies Record<LimitErrorCode, string>;

const CODES: ReadonlySet<string> = new Set(LIMIT_ERROR_CODES);

/** Narrows an arbitrary string — a close reason, an error code — to a known limit. */
export function asLimitCode(value: unknown): LimitErrorCode | null {
  return typeof value === "string" && CODES.has(value) ? (value as LimitErrorCode) : null;
}

/** The i18n key describing a limit. Literal, so the translation type checks it like any other. */
export function limitMessageKey(code: LimitErrorCode): LimitMessageKey {
  return MESSAGE_KEYS[code];
}

export type LimitMessageKey = (typeof MESSAGE_KEYS)[LimitErrorCode];

/**
 * True when the recording survived the limit that stopped it.
 *
 * The three duration limits are of this kind — recorded audio, session lifetime and a pause that
 * outlasted its allowance: each one finalizes what the server already holds, so the meeting is
 * complete and playable and the pipeline runs as usual. Every other limit refuses something, and
 * saying "your recording is safe" about a refusal would be a lie.
 */
export function isRecordingFinalizedDespite(code: LimitErrorCode): boolean {
  return FINALIZING_CODES.has(code);
}

const FINALIZING_CODES: ReadonlySet<LimitErrorCode> = new Set([
  "limit.session_duration_exceeded",
  "limit.session_lifetime_exceeded",
  "limit.pause_duration_exceeded",
]);
