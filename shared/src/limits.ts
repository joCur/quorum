import { z } from "zod";

/**
 * Machine-readable reasons a request or a recording session is refused because it would exceed a
 * configured limit.
 *
 * The codes are the contract between server and client: the server never sends a user-facing
 * sentence, it sends one of these codes, and the client renders the message through i18n
 * (CLAUDE.md). They travel in the `error` field of a REST error body and in the `reason` of a
 * WebSocket close frame, which is why they are short enough to fit the 123-byte close-reason
 * budget of RFC 6455.
 */
export const LIMIT_ERROR_CODES = [
  /** The recording ran past the maximum session duration and was finalized by the server. */
  "limit.session_duration_exceeded",
  /** The user already has the maximum number of recording sessions open. */
  "limit.parallel_sessions_exceeded",
  /** Chunk frames arrived faster than the per-session chunk rate allows. */
  "limit.chunk_rate_exceeded",
  /** Chunk frames carried more bytes per second than the per-session byte rate allows. */
  "limit.byte_rate_exceeded",
  /** The stored audio of this user already fills their storage quota. */
  "limit.storage_quota_exceeded",
  /** The user has recorded their allowance of hours for the current calendar month. */
  "limit.monthly_hours_quota_exceeded",
  /** Too many REST requests in the current window. Answered with HTTP 429. */
  "limit.request_rate_exceeded",
] as const;

export const LimitErrorCodeSchema = z.enum(LIMIT_ERROR_CODES);

export type LimitErrorCode = (typeof LIMIT_ERROR_CODES)[number];
