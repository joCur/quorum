/**
 * Abuse and cost protection for the recording endpoint.
 *
 * The GPU worker is the expensive part of this system, and every second of audio that reaches
 * object storage eventually buys GPU time and model tokens (see `COST-MODEL.md`). The limits
 * here bound what a single connection, and a single user, can push into that pipeline before
 * anything downstream has a chance to say no.
 *
 * All of them are configured from the environment with defaults that sit far above any real
 * meeting, so an honest recording never meets them.
 */

/** Per-session and per-user limits enforced by the recording endpoint. */
export interface RecordingLimits {
  /**
   * Wall-clock length after which the server finalizes the recording itself. The session is not
   * discarded: what has been persisted becomes a normal, playable meeting.
   */
  readonly maxSessionSeconds: number;
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
}

/**
 * Defaults chosen against what a real recording does, not against what feels round.
 *
 * - Four hours is longer than any meeting this product is for, and it caps a single runaway
 *   session at roughly 0.40 € of marginal cost.
 * - Three parallel sessions covers a laptop plus a phone plus one stale connection that has not
 *   timed out yet.
 * - Chunks are 1–2 s of audio (ADR-002), so a live recording sends 0.5–1 chunk/s and about
 *   4 KiB/s of Opus. Twenty chunks and 4 MiB per second are therefore 20x and 1000x above live
 *   speed — head room for a replay, still a hard ceiling on sustained throughput.
 * - Ten seconds of burst lets a client dump 200 buffered chunks in one go.
 */
export const DEFAULT_RECORDING_LIMITS: RecordingLimits = {
  maxSessionSeconds: 4 * 60 * 60,
  maxParallelSessions: 3,
  maxChunksPerSecond: 20,
  maxBytesPerSecond: 4 * 1024 * 1024,
  burstSeconds: 10,
};

/**
 * Token bucket over a monotonic clock.
 *
 * Deliberately in memory and per connection: it protects one socket from one client, costs a few
 * numbers, and needs no coordination. Cross-replica accounting belongs to a shared store and to
 * limits that are about a user rather than about a connection.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    /** Tokens added per second. */
    private readonly ratePerSecond: number,
    /** Maximum tokens the bucket can hold — the burst allowance. */
    private readonly capacity: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  /**
   * Takes `cost` tokens, refilling first. Returns `false` when the bucket cannot cover the cost,
   * in which case nothing is taken — a refused frame must not deepen the deficit.
   */
  take(cost: number): boolean {
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.updatedAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.ratePerSecond);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** The two rate buckets a single recording connection is metered by. */
export class ConnectionRateMeter {
  private readonly chunks: TokenBucket;
  private readonly bytes: TokenBucket;

  constructor(limits: RecordingLimits, now: () => number = () => Date.now()) {
    this.chunks = new TokenBucket(
      limits.maxChunksPerSecond,
      limits.maxChunksPerSecond * limits.burstSeconds,
      now,
    );
    this.bytes = new TokenBucket(
      limits.maxBytesPerSecond,
      limits.maxBytesPerSecond * limits.burstSeconds,
      now,
    );
  }

  /**
   * Accounts for one incoming frame of `byteLength` bytes. Returns the limit that was exceeded,
   * or `null` when the frame is within both rates.
   *
   * The chunk bucket is charged first and only when it holds a token, so a frame refused for its
   * size does not also consume the count allowance.
   */
  admit(byteLength: number): "chunks" | "bytes" | null {
    if (!this.chunks.take(1)) return "chunks";
    if (!this.bytes.take(byteLength)) return "bytes";
    return null;
  }
}

/**
 * In-process record of which sessions a user currently has open.
 *
 * Scoped by tenant and user (ADR-001), keyed by session id so that a reconnect for a session the
 * user already owns is admitted rather than counted twice — otherwise a flaky network would lock
 * a user out of their own recording while the dead connection times out.
 *
 * Per process, on purpose: it is a cheap ceiling against one client opening sockets in a loop,
 * not a cluster-wide quota. With several API replicas the effective cap is the configured number
 * times the replica count; the durable limits that bound real cost are the storage and monthly
 * hour quotas.
 */
export class SessionRegistry {
  private readonly open = new Map<string, Set<string>>();

  constructor(private readonly maxParallelSessions: number) {}

  /** Registers a session for a user, or returns `false` when that would exceed the cap. */
  acquire(scope: { tenantId: string; userId: string }, sessionId: string): boolean {
    const key = scopeKey(scope);
    const sessions = this.open.get(key) ?? new Set<string>();
    if (!sessions.has(sessionId) && sessions.size >= this.maxParallelSessions) return false;
    sessions.add(sessionId);
    this.open.set(key, sessions);
    return true;
  }

  release(scope: { tenantId: string; userId: string }, sessionId: string): void {
    const key = scopeKey(scope);
    const sessions = this.open.get(key);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) this.open.delete(key);
  }

  /** Number of sessions currently open for a user. Exists for tests and for diagnostics. */
  countFor(scope: { tenantId: string; userId: string }): number {
    return this.open.get(scopeKey(scope))?.size ?? 0;
  }
}

function scopeKey(scope: { tenantId: string; userId: string }): string {
  // A separator that cannot occur in an identifier, so two scopes cannot collide into one key.
  return `${scope.tenantId}\u0000${scope.userId}`;
}
