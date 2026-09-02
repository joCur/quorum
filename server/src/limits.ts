/**
 * Abuse and cost protection: what one user is allowed to consume.
 *
 * The GPU worker is the expensive part of this system, and every second of audio that reaches
 * object storage eventually buys GPU time and model tokens (see `docs/COST-MODEL.md`). The limits here
 * bound what a single user can push into that pipeline before anything downstream has a chance to
 * say no — over the recording socket and over the REST API alike.
 *
 * All of them are configured from the environment with defaults that sit far above any real
 * meeting, so an honest user never meets them.
 */

/** Everything one user is allowed to do. Resolved per tenant and user, never read as a constant. */
export interface UserLimits {
  /**
   * Seconds of RECORDED AUDIO after which the server finalizes the recording itself.
   *
   * Audio time, not wall clock: a meeting that is paused over a lunch break spends none of this
   * allowance while it is paused. This is the limit that tracks cost, because cost follows the
   * seconds of audio that reach the pipeline, not the seconds a socket stays open.
   *
   * The session is not discarded: what has been persisted becomes a normal, playable meeting.
   */
  readonly maxRecordedSeconds: number;
  /**
   * Wall-clock seconds a session may stay open, pauses included.
   *
   * Pure resource protection for the open session — the socket, the in-memory state and the
   * parallel-session slot it holds. Deliberately far above `maxRecordedSeconds`, so only a session
   * that was forgotten rather than used ever reaches it. It finalizes the same way.
   */
  readonly maxSessionLifetimeSeconds: number;
  /**
   * Wall-clock seconds a single pause may last before the session is finalized.
   *
   * A break longer than this is not a break any more: the meeting is closed as a complete, playable
   * recording, and picking work up again starts a new session. Finalized, never killed — the
   * difference between a user coming back to a finished meeting and coming back to nothing.
   */
  readonly maxPauseSeconds: number;
  /** How many recording sessions one user may have open at the same time. */
  readonly maxParallelSessions: number;
  /** Sustained chunk frames per second a single connection may send. */
  readonly maxChunksPerSecond: number;
  /** Sustained bytes per second a single connection may send. */
  readonly maxBytesPerSecond: number;
  /**
   * How many seconds' worth of the two rates above a connection may spend at once.
   *
   * This is what makes a reconnect work: a client that buffered audio while offline replays it as
   * fast as the socket allows, and that burst must not look like an attack.
   */
  readonly burstSeconds: number;
  /** Total bytes of stored audio one user may hold. */
  readonly maxStorageBytes: number;
  /** Seconds a user may record within one calendar month (UTC). */
  readonly maxMonthlyRecordedSeconds: number;
  /**
   * How many chunks may be persisted between two usage flushes to the meeting index.
   *
   * The flush is what makes the quotas survive a restart: without it a session that never reaches
   * `session.end` would have cost real storage and counted for nothing.
   */
  readonly usageFlushChunks: number;
  /** REST requests one user may make per window. */
  readonly apiRequestsPerWindow: number;
  /** Length of that window, in seconds. */
  readonly apiWindowSeconds: number;
  /**
   * Requests per window to a route that buys pipeline work — regenerating a summary, retrying a
   * transcription — each metered on a counter of its own.
   *
   * Its own, much smaller number because those are the requests that cost something to serve: the
   * rest of the API reads rows the pipeline already produced.
   */
  readonly apiSummaryRequestsPerWindow: number;
}

/**
 * Defaults chosen against what a real recording does, not against what feels round.
 *
 * - Four hours of audio is longer than any meeting this product is for, and it caps a single
 *   runaway session at roughly 0.40 € of marginal cost. Because it counts audio, a day of
 *   workshop with breaks in it still fits.
 * - Twelve hours of session lifetime is longer than any working day of meetings and costs nothing
 *   by itself; it exists so a forgotten session cannot hold a socket and a session slot forever.
 * - Two hours of pause is longer than a lunch break and shorter than "tomorrow": past it, closing
 *   the meeting is what the user would have wanted anyway.
 * - Three parallel sessions covers a laptop plus a phone plus one stale connection that has not
 *   timed out yet.
 * - Chunks are 1–2 s of audio (ADR-002), so a live recording sends 0.5–1 chunk/s and about
 *   4 KiB/s of Opus. Twenty chunks and 4 MiB per second are therefore 20x and 1000x above live
 *   speed — head room for a replay, still a hard ceiling on sustained throughput.
 * - Ten seconds of burst lets a client dump 200 buffered chunks in one go.
 * - 50 GiB of stored audio is roughly 3,000 hours of Opus, and 100 recorded hours a month is
 *   around 10 € of marginal cost — generous for one user, bounded for the operator.
 * - Flushing usage every 64 chunks is roughly every one to two minutes of audio: often enough
 *   that a crash loses almost nothing, rare enough to stay invisible next to the chunk writes.
 * - 300 API requests a minute is far more than the client's list, detail and polling traffic, and
 *   the ten regenerate requests a minute next to it are ten model calls a minute — the ceiling
 *   that actually costs money.
 */
export const DEFAULT_USER_LIMITS: UserLimits = {
  maxRecordedSeconds: 4 * 60 * 60,
  maxSessionLifetimeSeconds: 12 * 60 * 60,
  maxPauseSeconds: 2 * 60 * 60,
  maxParallelSessions: 3,
  maxChunksPerSecond: 20,
  maxBytesPerSecond: 4 * 1024 * 1024,
  burstSeconds: 10,
  maxStorageBytes: 50 * 1024 * 1024 * 1024,
  maxMonthlyRecordedSeconds: 100 * 60 * 60,
  usageFlushChunks: 64,
  apiRequestsPerWindow: 300,
  apiWindowSeconds: 60,
  apiSummaryRequestsPerWindow: 10,
};

/**
 * Where an enforcement site gets its numbers.
 *
 * Every limit is looked up per tenant and user through this port, and no enforcement site reads a
 * constant of its own. In V1 the answer is always the environment configuration, but plan tiers
 * are coming: a paid plan that records longer or stores more is then a different implementation of
 * this one interface, not a change at every place a limit is checked.
 */
export interface UserLimitsResolver {
  resolve(scope: { tenantId: string; userId: string }): Promise<UserLimits>;
}

/** The V1 resolver: one set of limits, from the environment, for everybody. */
export class StaticUserLimitsResolver implements UserLimitsResolver {
  constructor(private readonly limits: UserLimits = DEFAULT_USER_LIMITS) {}

  async resolve(): Promise<UserLimits> {
    return this.limits;
  }
}

/** Start of the calendar month `at` falls in, in UTC — the window the monthly quota counts over. */
export function monthStart(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}
