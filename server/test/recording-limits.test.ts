import { describe, expect, it } from "vitest";
import { DEFAULT_USER_LIMITS, StaticUserLimitsResolver, type UserLimits } from "../src/limits.js";
import { ConnectionRateMeter, SessionRegistry, TokenBucket } from "../src/recording/limits.js";
import {
  CLOSE_NORMAL,
  CLOSE_POLICY_VIOLATION,
  RecordingSessionHandler,
} from "../src/recording/session.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { manifestKey } from "../src/recording/keys.js";
import { FakeConnection, WEBM_OPUS, chunk, idSequence } from "./helpers.js";

const SESSION_START = Date.parse("2026-08-29T10:00:00.000Z");

/** Limits small enough to reach in a test, with the same shape production uses. */
const TEST_LIMITS: UserLimits = {
  ...DEFAULT_USER_LIMITS,
  maxRecordedSeconds: 60,
  maxSessionLifetimeSeconds: 600,
  maxPauseSeconds: 120,
  maxParallelSessions: 2,
  maxChunksPerSecond: 2,
  maxBytesPerSecond: 1_000,
  burstSeconds: 1,
  maxStorageBytes: 10_000,
  maxMonthlyRecordedSeconds: 600,
  usageFlushChunks: 64,
};

/**
 * Sequence number whose audio offset lands exactly on the recorded-duration limit.
 *
 * The test chunk helper stamps `seq * 2` seconds of audio offset, which is what the recorded
 * duration is counted from — this is the boundary case, and `+ 1` is the first one past it.
 */
const LAST_SEQ_WITHIN_RECORDED_LIMIT = TEST_LIMITS.maxRecordedSeconds / 2;

/** A clock the test moves by hand, so no limit test depends on wall-clock timing. */
function clock(startMs = SESSION_START) {
  let current = startMs;
  return {
    now: () => new Date(current),
    /** The current time as a protocol timestamp, for the `at` of a pause or resume mark. */
    at: () => new Date(current).toISOString(),
    advanceSeconds(seconds: number) {
      current += seconds * 1000;
    },
  };
}

/**
 * The scheduler the handler arms its pause deadline on, under the test's control.
 *
 * A pause limit measured in hours cannot be waited out, and the handler takes its timer as a
 * dependency for exactly this reason: the test fires the deadline itself and asserts what the
 * handler does with it.
 */
function fakeTimers() {
  const armed = new Set<() => void>();
  return {
    schedule(callback: () => void): () => void {
      armed.add(callback);
      return () => armed.delete(callback);
    },
    pending: () => armed.size,
    async runPending(): Promise<void> {
      const callbacks = [...armed];
      armed.clear();
      for (const callback of callbacks) callback();
      // The deadline finalizes asynchronously; let those promises settle before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

interface Fixture {
  connection: FakeConnection;
  handler: RecordingSessionHandler;
  storage: InMemoryRecordingStorage;
  queue: InMemoryJobQueue;
}

function createFixture(
  options: {
    limits?: UserLimits;
    registry?: SessionRegistry;
    now?: () => Date;
    schedule?: (callback: () => void, delayMs: number) => () => void;
    userId?: string;
    storage?: InMemoryRecordingStorage;
    queue?: InMemoryJobQueue;
    idPrefix?: string;
  } = {},
): Fixture {
  const connection = new FakeConnection();
  const storage = options.storage ?? new InMemoryRecordingStorage();
  const queue = options.queue ?? new InMemoryJobQueue();
  const handler = new RecordingSessionHandler(connection, {
    storage,
    queue,
    context: { tenantId: "tenant-a", userId: options.userId ?? "user-1" },
    limits: new StaticUserLimitsResolver(options.limits ?? TEST_LIMITS),
    registry: options.registry,
    newId: idSequence(options.idPrefix ?? "0"),
    now: options.now ?? (() => new Date(SESSION_START)),
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  return { connection, handler, storage, queue };
}

async function pause(fixture: Fixture, sessionId: string, at: string): Promise<void> {
  await fixture.handler.handleText(JSON.stringify({ type: "session.pause", sessionId, at }));
}

async function resume(fixture: Fixture, sessionId: string, at: string): Promise<void> {
  await fixture.handler.handleText(JSON.stringify({ type: "session.resume", sessionId, at }));
}

async function start(fixture: Fixture): Promise<string> {
  await fixture.handler.handleText(
    JSON.stringify({
      type: "session.start",
      meetingTitle: "Weekly sync",
      audioFormat: WEBM_OPUS,
      clientInfo: { platform: "web-desktop", userAgent: "vitest" },
    }),
  );
  const ready = fixture.connection.last("session.ready");
  if (!ready)
    throw new Error(`session.ready was not sent: ${JSON.stringify(fixture.connection.closed)}`);
  return ready.sessionId;
}

describe("token bucket", () => {
  it("admits a burst up to capacity, refuses the one past it and refills over time", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 3, () => now);

    // Under and at the boundary: the full burst is available immediately.
    expect(bucket.take(1)).toBe(true);
    expect(bucket.take(1)).toBe(true);
    expect(bucket.take(1)).toBe(true);
    // Over: nothing left, and a refused take must not push the bucket further into debt.
    expect(bucket.take(1)).toBe(false);

    now += 2_000;
    expect(bucket.take(1)).toBe(true);
    expect(bucket.take(1)).toBe(true);
    expect(bucket.take(1)).toBe(false);
  });

  it("never refills past capacity, however long the connection was idle", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 2, () => now);
    now += 3_600_000;
    expect(bucket.take(2)).toBe(true);
    expect(bucket.take(1)).toBe(false);
  });

  it("reports which of the two rates a frame exceeded", () => {
    const now = 0;
    const meter = new ConnectionRateMeter(
      { ...TEST_LIMITS, maxChunksPerSecond: 10, maxBytesPerSecond: 100, burstSeconds: 1 },
      () => now,
    );
    expect(meter.admit(60)).toBeNull();
    expect(meter.admit(40)).toBeNull();
    expect(meter.admit(1)).toBe("bytes");

    const chunky = new ConnectionRateMeter(
      { ...TEST_LIMITS, maxChunksPerSecond: 2, maxBytesPerSecond: 1_000_000, burstSeconds: 1 },
      () => now,
    );
    expect(chunky.admit(1)).toBeNull();
    expect(chunky.admit(1)).toBeNull();
    expect(chunky.admit(1)).toBe("chunks");
  });
});

describe("WebSocket rate limits", () => {
  it("accepts a chunk rate at the limit and closes the connection above it", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);

    // Capacity is `maxChunksPerSecond * burstSeconds` = 2 frames.
    await fixture.handler.handleBinary(chunk(sessionId, 0));
    await fixture.handler.handleBinary(chunk(sessionId, 1));
    expect(fixture.connection.closed).toBeNull();
    expect(fixture.connection.last("chunk.ack")?.persistedSeq).toBe(1);

    await fixture.handler.handleBinary(chunk(sessionId, 2));
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_POLICY_VIOLATION,
      reason: "limit.chunk_rate_exceeded",
    });
  });

  it("lets the rate recover once the client slows down", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);

    for (let seq = 0; seq < 6; seq += 1) {
      await fixture.handler.handleBinary(chunk(sessionId, seq));
      time.advanceSeconds(1);
    }
    expect(fixture.connection.closed).toBeNull();
    expect(fixture.connection.last("chunk.ack")?.persistedSeq).toBe(5);
  });

  it("closes the connection when the byte rate is exceeded", async () => {
    const time = clock();
    const fixture = createFixture({
      now: time.now,
      limits: { ...TEST_LIMITS, maxChunksPerSecond: 1_000, maxBytesPerSecond: 200 },
    });
    const sessionId = await start(fixture);

    // Two frames of roughly 150 bytes: the first fits the 200-byte allowance, the second does not.
    const body = Array.from({ length: 120 }, (_, index) => index % 251);
    await fixture.handler.handleBinary(chunk(sessionId, 0, body));
    expect(fixture.connection.closed).toBeNull();
    await fixture.handler.handleBinary(chunk(sessionId, 1, body));
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_POLICY_VIOLATION,
      reason: "limit.byte_rate_exceeded",
    });
  });
});

describe("maximum recorded duration", () => {
  it("keeps recording right up to the limit", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);

    // The last chunk that still fits: its audio offset is exactly the limit.
    await fixture.handler.handleBinary(chunk(sessionId, LAST_SEQ_WITHIN_RECORDED_LIMIT));

    expect(fixture.connection.closed).toBeNull();
    // Persisted, not acknowledged: it is the only chunk so far, so the contiguous run still
    // starts at nothing. What matters here is that the limit let it through.
    expect(fixture.storage.objects.size).toBeGreaterThan(1);
  });

  it("finalizes the recording itself once the limit is passed", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);
    await fixture.handler.handleBinary(chunk(sessionId, 0));
    await fixture.handler.handleBinary(chunk(sessionId, 1));

    // A second of wall clock so the third frame is not refused by the chunk rate instead.
    time.advanceSeconds(1);
    await fixture.handler.handleBinary(chunk(sessionId, LAST_SEQ_WITHIN_RECORDED_LIMIT + 1));

    // The recording survives as a valid meeting: manifest written, transcription enqueued, and
    // the client is told the session is finalized before the socket closes.
    const finalized = fixture.connection.last("session.finalized");
    expect(finalized?.sessionId).toBe(sessionId);
    const scope = { tenantId: "tenant-a", userId: "user-1", sessionId };
    const manifest = JSON.parse(
      new TextDecoder().decode(fixture.storage.objects.get(manifestKey(scope))),
    ) as { persistedSeq: number; chunkCount: number };
    expect(manifest.persistedSeq).toBe(1);
    expect(manifest.chunkCount).toBe(2);
    expect(fixture.queue.enqueued).toHaveLength(1);
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_NORMAL,
      reason: "limit.session_duration_exceeded",
    });
  });

  it("counts audio, so time spent paused does not consume the allowance", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);
    await fixture.handler.handleBinary(chunk(sessionId, 0));

    await pause(fixture, sessionId, time.at());
    // Longer than the whole recorded-duration allowance, and still a legal pause.
    time.advanceSeconds(TEST_LIMITS.maxPauseSeconds);
    await resume(fixture, sessionId, time.at());

    await fixture.handler.handleBinary(chunk(sessionId, 1));

    expect(fixture.connection.closed).toBeNull();
    expect(fixture.connection.last("chunk.ack")?.persistedSeq).toBe(1);
  });

  it("does not revive a session that ran past the limit while it was disconnected", async () => {
    const time = clock();
    const first = createFixture({ now: time.now });
    const sessionId = await start(first);
    await first.handler.handleBinary(chunk(sessionId, 0));

    time.advanceSeconds(TEST_LIMITS.maxSessionLifetimeSeconds + 1);
    const resumed = createFixture({
      now: time.now,
      storage: first.storage,
      queue: first.queue,
      idPrefix: "1",
    });
    await resumed.handler.handleText(
      JSON.stringify({
        type: "session.resume",
        sessionId,
        at: new Date(SESSION_START).toISOString(),
      }),
    );

    expect(resumed.connection.closed).toEqual({
      code: CLOSE_NORMAL,
      reason: "limit.session_lifetime_exceeded",
    });
  });
});

describe("maximum session lifetime", () => {
  it("keeps recording right up to the ceiling", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);

    time.advanceSeconds(TEST_LIMITS.maxSessionLifetimeSeconds);
    await fixture.handler.handleBinary(chunk(sessionId, 0));

    expect(fixture.connection.closed).toBeNull();
    expect(fixture.connection.last("chunk.ack")?.persistedSeq).toBe(0);
  });

  it("finalizes a session that stayed open past the ceiling", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);
    await fixture.handler.handleBinary(chunk(sessionId, 0));

    time.advanceSeconds(TEST_LIMITS.maxSessionLifetimeSeconds + 1);
    await fixture.handler.handleBinary(chunk(sessionId, 1));

    expect(fixture.connection.last("session.finalized")?.sessionId).toBe(sessionId);
    expect(fixture.queue.enqueued).toHaveLength(1);
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_NORMAL,
      reason: "limit.session_lifetime_exceeded",
    });
  });
});

describe("maximum pause duration", () => {
  it("resumes normally right up to the allowance", async () => {
    const time = clock();
    const timers = fakeTimers();
    const fixture = createFixture({ now: time.now, schedule: timers.schedule });
    const sessionId = await start(fixture);
    await fixture.handler.handleBinary(chunk(sessionId, 0));

    await pause(fixture, sessionId, time.at());
    time.advanceSeconds(TEST_LIMITS.maxPauseSeconds);
    await resume(fixture, sessionId, time.at());
    await fixture.handler.handleBinary(chunk(sessionId, 1));

    expect(fixture.connection.closed).toBeNull();
    expect(fixture.connection.last("chunk.ack")?.persistedSeq).toBe(1);
    // The deadline is disarmed by the resume, not left to fire into a running recording.
    expect(timers.pending()).toBe(0);
  });

  it("finalizes cleanly when the pause outlasts the allowance", async () => {
    const time = clock();
    const timers = fakeTimers();
    const fixture = createFixture({ now: time.now, schedule: timers.schedule });
    const sessionId = await start(fixture);
    await fixture.handler.handleBinary(chunk(sessionId, 0));
    await fixture.handler.handleBinary(chunk(sessionId, 1));

    await pause(fixture, sessionId, time.at());
    time.advanceSeconds(TEST_LIMITS.maxPauseSeconds + 1);
    await timers.runPending();

    // Finalized, never killed: the meeting is complete and playable, and the job is queued.
    expect(fixture.connection.last("session.finalized")?.sessionId).toBe(sessionId);
    const scope = { tenantId: "tenant-a", userId: "user-1", sessionId };
    const manifest = JSON.parse(
      new TextDecoder().decode(fixture.storage.objects.get(manifestKey(scope))),
    ) as { persistedSeq: number; chunkCount: number };
    expect(manifest.chunkCount).toBe(2);
    expect(fixture.queue.enqueued).toHaveLength(1);
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_NORMAL,
      reason: "limit.pause_duration_exceeded",
    });
  });

  it("finalizes a resume that arrives after the pause allowance ran out", async () => {
    const time = clock();
    const fixture = createFixture({ now: time.now });
    const sessionId = await start(fixture);
    await fixture.handler.handleBinary(chunk(sessionId, 0));

    await pause(fixture, sessionId, time.at());
    time.advanceSeconds(TEST_LIMITS.maxPauseSeconds + 1);
    await resume(fixture, sessionId, time.at());

    expect(fixture.connection.closed).toEqual({
      code: CLOSE_NORMAL,
      reason: "limit.pause_duration_exceeded",
    });
  });

  it("holds across a reconnect, because the pause mark is what is judged", async () => {
    const time = clock();
    const first = createFixture({ now: time.now });
    const sessionId = await start(first);
    await first.handler.handleBinary(chunk(sessionId, 0));
    await pause(first, sessionId, time.at());

    time.advanceSeconds(TEST_LIMITS.maxPauseSeconds + 1);
    const resumed = createFixture({
      now: time.now,
      storage: first.storage,
      queue: first.queue,
      idPrefix: "1",
    });
    await resume(resumed, sessionId, time.at());

    expect(resumed.connection.closed).toEqual({
      code: CLOSE_NORMAL,
      reason: "limit.pause_duration_exceeded",
    });
    expect(resumed.queue.enqueued).toHaveLength(1);
  });

  it("drops the armed deadline when the connection goes away", async () => {
    const time = clock();
    const timers = fakeTimers();
    const fixture = createFixture({ now: time.now, schedule: timers.schedule });
    const sessionId = await start(fixture);
    await pause(fixture, sessionId, time.at());
    expect(timers.pending()).toBe(1);

    fixture.handler.dispose();

    expect(timers.pending()).toBe(0);
  });
});

describe("parallel session cap", () => {
  it("admits sessions up to the cap and refuses the one past it", async () => {
    const registry = new SessionRegistry();
    const scope = { tenantId: "tenant-a", userId: "user-1" };

    const first = createFixture({ registry, idPrefix: "1" });
    const second = createFixture({ registry, idPrefix: "2" });
    await start(first);
    await start(second);
    expect(registry.countFor(scope)).toBe(2);

    const third = createFixture({ registry, idPrefix: "3" });
    await third.handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: null,
        audioFormat: WEBM_OPUS,
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    expect(third.connection.last("session.ready")).toBeUndefined();
    expect(third.connection.closed).toEqual({
      code: CLOSE_POLICY_VIOLATION,
      reason: "limit.parallel_sessions_exceeded",
    });
    // A refused session must not have been written to storage.
    expect(third.storage.objects.size).toBe(0);
  });

  it("counts the cap per user, not per tenant", async () => {
    const registry = new SessionRegistry();
    const soloLimits = { ...TEST_LIMITS, maxParallelSessions: 1 };
    const mine = createFixture({ registry, limits: soloLimits, userId: "user-1", idPrefix: "1" });
    const yours = createFixture({ registry, limits: soloLimits, userId: "user-2", idPrefix: "2" });

    await start(mine);
    await start(yours);
    expect(registry.countFor({ tenantId: "tenant-a", userId: "user-1" })).toBe(1);
    expect(registry.countFor({ tenantId: "tenant-a", userId: "user-2" })).toBe(1);
  });

  it("frees the slot when the connection goes away", async () => {
    const registry = new SessionRegistry();
    const soloLimits = { ...TEST_LIMITS, maxParallelSessions: 1 };
    const scope = { tenantId: "tenant-a", userId: "user-1" };
    const first = createFixture({ registry, limits: soloLimits, idPrefix: "1" });
    await start(first);
    first.handler.dispose();
    expect(registry.countFor(scope)).toBe(0);

    const second = createFixture({ registry, limits: soloLimits, idPrefix: "2" });
    await start(second);
    expect(second.connection.closed).toBeNull();
  });

  it("does not count a reconnect to the same session twice", async () => {
    const registry = new SessionRegistry();
    const soloLimits = { ...TEST_LIMITS, maxParallelSessions: 1 };
    const scope = { tenantId: "tenant-a", userId: "user-1" };
    const time = clock();
    const first = createFixture({ registry, limits: soloLimits, now: time.now, idPrefix: "1" });
    const sessionId = await start(first);
    await first.handler.handleBinary(chunk(sessionId, 0));

    // The dead connection has not been cleaned up yet, so its slot is still taken.
    time.advanceSeconds(5);
    const resumed = createFixture({
      registry,
      limits: soloLimits,
      now: time.now,
      storage: first.storage,
      queue: first.queue,
      idPrefix: "2",
    });
    await resumed.handler.handleText(
      JSON.stringify({
        type: "session.resume",
        sessionId,
        at: new Date(SESSION_START + 5_000).toISOString(),
      }),
    );

    expect(resumed.connection.closed).toBeNull();
    expect(resumed.connection.last("chunk.ack")?.persistedSeq).toBe(0);
    expect(registry.countFor(scope)).toBe(1);
  });
});

describe("default limits", () => {
  it("stays far above what a real recording does", () => {
    // A live recording sends 0.5–1 chunk/s and roughly 4 KiB/s of Opus (ADR-002, docs/COST-MODEL.md).
    // The e2e suite records for seconds, so the defaults must never be in its way.
    expect(DEFAULT_USER_LIMITS.maxChunksPerSecond).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_USER_LIMITS.maxBytesPerSecond).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_USER_LIMITS.maxRecordedSeconds).toBeGreaterThanOrEqual(60 * 60);
    // The wall-clock ceiling only exists to catch a forgotten session, so it has to sit well
    // above a full recording plus the breaks inside it.
    expect(DEFAULT_USER_LIMITS.maxSessionLifetimeSeconds).toBeGreaterThan(
      DEFAULT_USER_LIMITS.maxRecordedSeconds,
    );
    // Longer than a lunch break, or an honest user comes back to a closed meeting.
    expect(DEFAULT_USER_LIMITS.maxPauseSeconds).toBeGreaterThanOrEqual(60 * 60);
    expect(DEFAULT_USER_LIMITS.maxParallelSessions).toBeGreaterThanOrEqual(2);
  });
});
