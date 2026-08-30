/**
 * The counting mechanics behind the recording endpoint's limits.
 *
 * The numbers themselves live in `../limits.ts` and are resolved per user; what is here is only
 * how they are counted on one connection and across one user's connections.
 */
import type { UserLimits } from "../limits.js";

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

  constructor(limits: UserLimits, now: () => number = () => Date.now()) {
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

  /**
   * Registers a session for a user, or returns `false` when that would exceed the cap.
   *
   * The cap is passed in rather than held here: it is a per-user limit that a plan tier may
   * change, so it belongs to whatever the resolver said about *this* user, not to the registry.
   */
  acquire(
    scope: { tenantId: string; userId: string },
    sessionId: string,
    maxParallelSessions: number,
  ): boolean {
    const key = scopeKey(scope);
    const sessions = this.open.get(key) ?? new Set<string>();
    if (!sessions.has(sessionId) && sessions.size >= maxParallelSessions) return false;
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
