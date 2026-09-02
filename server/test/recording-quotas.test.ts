import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SCHEMA_VERSION, type Transcript } from "@quorum/shared";
import {
  DEFAULT_USER_LIMITS,
  StaticUserLimitsResolver,
  monthStart,
  type UserLimits,
  type UserLimitsResolver,
} from "../src/limits.js";
import { CLOSE_POLICY_VIOLATION, RecordingSessionHandler } from "../src/recording/session.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import type { AccountUsage } from "../src/recording/types.js";
import { FakeConnection, WEBM_OPUS, chunk, idSequence } from "./helpers.js";

const NOW = new Date("2026-08-29T10:00:00.000Z");
const SCOPE = { tenantId: "tenant-a", userId: "user-1" };

const TEST_LIMITS: UserLimits = {
  ...DEFAULT_USER_LIMITS,
  maxStorageBytes: 1_000,
  maxMonthlyRecordedSeconds: 600,
  usageFlushChunks: 64,
};

interface Fixture {
  connection: FakeConnection;
  handler: RecordingSessionHandler;
  meetings: InMemoryMeetingStore;
  storage: InMemoryRecordingStorage;
}

function createFixture(
  options: {
    limits?: UserLimits | UserLimitsResolver;
    meetings?: InMemoryMeetingStore;
    userId?: string;
    idPrefix?: string;
  } = {},
): Fixture {
  const connection = new FakeConnection();
  const storage = new InMemoryRecordingStorage();
  const meetings = options.meetings ?? new InMemoryMeetingStore();
  const limits = options.limits ?? TEST_LIMITS;
  const handler = new RecordingSessionHandler(connection, {
    storage,
    queue: new InMemoryJobQueue(),
    meetings,
    context: { tenantId: SCOPE.tenantId, userId: options.userId ?? SCOPE.userId },
    limits:
      "resolve" in limits ? (limits as UserLimitsResolver) : new StaticUserLimitsResolver(limits),
    newId: idSequence(options.idPrefix ?? "0"),
    now: () => NOW,
  });
  return { connection, handler, meetings, storage };
}

async function start(fixture: Fixture): Promise<string | null> {
  await fixture.handler.handleText(
    JSON.stringify({
      type: "session.start",
      meetingTitle: "Weekly sync",
      audioFormat: WEBM_OPUS,
      clientInfo: { platform: "web-desktop", userAgent: "vitest" },
    }),
  );
  return fixture.connection.last("session.ready")?.sessionId ?? null;
}

/** Puts a finished meeting with a known cost into the index. */
async function seedMeeting(
  meetings: InMemoryMeetingStore,
  input: {
    id: string;
    createdAt: string;
    audioBytes: number;
    recordedSeconds: number;
    userId?: string;
  },
): Promise<void> {
  const userId = input.userId ?? SCOPE.userId;
  await meetings.recordSession({
    meetingId: input.id,
    sessionId: `session-${input.id}`,
    tenantId: SCOPE.tenantId,
    userId,
    title: "Earlier meeting",
    audioFormat: WEBM_OPUS,
    createdAt: input.createdAt,
  });
  await meetings.recordUsage({ tenantId: SCOPE.tenantId, userId }, `session-${input.id}`, {
    audioBytes: input.audioBytes,
    recordedSeconds: input.recordedSeconds,
  });
}

/** A transcript whose last segment ends after `seconds` — the reconciled duration of a meeting. */
function transcriptOf(meetingId: string, seconds: number): Transcript {
  return {
    id: `11111111-1111-4111-8111-11111111111${meetingId.slice(-1)}`,
    meetingId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "whisper",
    modelVersion: "large-v3",
    language: "en",
    recordedAt: "2026-08-02T09:00:00.000Z",
    createdAt: "2026-08-02T09:30:00.000Z",
    speakers: [],
    segments: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        start: 0,
        end: seconds,
        text: "The whole meeting.",
        editedText: null,
        confidence: 0.9,
        speakerId: null,
        editedSpeakerId: null,
        language: null,
        words: null,
      },
    ],
  };
}

describe("month window", () => {
  it("starts at the first instant of the calendar month, in UTC", () => {
    expect(monthStart(new Date("2026-08-29T10:00:00.000Z"))).toBe("2026-08-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("storage quota", () => {
  it("lets a session start below the quota", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: NOW.toISOString(),
      audioBytes: 999,
      recordedSeconds: 10,
    });
    const fixture = createFixture({ meetings });
    expect(await start(fixture)).not.toBeNull();
  });

  it("refuses a session once the stored audio reaches the quota", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: NOW.toISOString(),
      audioBytes: TEST_LIMITS.maxStorageBytes,
      recordedSeconds: 10,
    });
    const fixture = createFixture({ meetings });

    expect(await start(fixture)).toBeNull();
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_POLICY_VIOLATION,
      reason: "limit.storage_quota_exceeded",
    });
    // A refused session leaves nothing behind.
    expect(fixture.storage.objects.size).toBe(0);
  });

  it("counts every meeting of the user, and only theirs", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: NOW.toISOString(),
      audioBytes: 600,
      recordedSeconds: 10,
    });
    await seedMeeting(meetings, {
      id: "meeting-2",
      createdAt: NOW.toISOString(),
      audioBytes: 500,
      recordedSeconds: 10,
    });

    expect(await start(createFixture({ meetings }))).toBeNull();
    // Another user in the same tenant is unaffected by what this one stored (ADR-001).
    expect(
      await start(createFixture({ meetings, userId: "user-2", idPrefix: "2" })),
    ).not.toBeNull();
  });
});

describe("monthly recording quota", () => {
  it("refuses a session once the month's recorded seconds reach the quota", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: "2026-08-02T09:00:00.000Z",
      audioBytes: 10,
      recordedSeconds: TEST_LIMITS.maxMonthlyRecordedSeconds,
    });
    const fixture = createFixture({ meetings });

    expect(await start(fixture)).toBeNull();
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_POLICY_VIOLATION,
      reason: "limit.monthly_hours_quota_exceeded",
    });
  });

  it("does not count recordings from an earlier month", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: "2026-07-31T23:59:59.000Z",
      audioBytes: 10,
      recordedSeconds: TEST_LIMITS.maxMonthlyRecordedSeconds * 10,
    });
    expect(await start(createFixture({ meetings }))).not.toBeNull();
  });

  it("lets a session start one second below the quota", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: "2026-08-02T09:00:00.000Z",
      audioBytes: 10,
      recordedSeconds: TEST_LIMITS.maxMonthlyRecordedSeconds - 1,
    });
    expect(await start(createFixture({ meetings }))).not.toBeNull();
  });

  it("charges a transcribed meeting for the audio it produced, not for what was asserted", async () => {
    const meetings = new InMemoryMeetingStore();
    // The client claimed a minute; the transcript proves the audio filled the whole allowance.
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: "2026-08-02T09:00:00.000Z",
      audioBytes: 10,
      recordedSeconds: 60,
    });
    meetings.setPipeline("meeting-1", {
      transcript: transcriptOf("meeting-1", 60),
      transcriptDurationSeconds: TEST_LIMITS.maxMonthlyRecordedSeconds,
    });
    const fixture = createFixture({ meetings });

    expect(await start(fixture)).toBeNull();
    expect(fixture.connection.closed).toEqual({
      code: CLOSE_POLICY_VIOLATION,
      reason: "limit.monthly_hours_quota_exceeded",
    });
  });

  it("bills the measured duration, not the last segment's end", async () => {
    // With the silence filter on, a recording that ends in quiet has a last segment well before
    // the end of its audio. The store must bill what the backend measured, exactly as the SQL
    // store bills its `duration_seconds` column.
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: "2026-08-02T09:00:00.000Z",
      audioBytes: 10,
      recordedSeconds: 60,
    });
    meetings.setPipeline("meeting-1", {
      transcript: transcriptOf("meeting-1", 30),
      transcriptDurationSeconds: TEST_LIMITS.maxMonthlyRecordedSeconds,
    });

    const fixture = createFixture({ meetings });
    expect(await start(fixture)).toBeNull();
    // And the list shows the number that was billed, not a shorter one.
    const [listed] = await meetings.listMeetings(SCOPE);
    expect(listed?.durationSeconds).toBe(TEST_LIMITS.maxMonthlyRecordedSeconds);
  });

  it("does not hand a measured duration back when a later transcript has none", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: "2026-08-02T09:00:00.000Z",
      audioBytes: 10,
      recordedSeconds: 60,
    });
    meetings.setPipeline("meeting-1", {
      transcript: transcriptOf("meeting-1", 30),
      transcriptDurationSeconds: TEST_LIMITS.maxMonthlyRecordedSeconds,
    });
    // Reprocessed by a backend that reports no duration: the earlier measurement stands.
    meetings.setPipeline("meeting-1", { transcript: transcriptOf("meeting-1", 30) });

    const fixture = createFixture({ meetings });
    expect(await start(fixture)).toBeNull();
    expect(fixture.connection.closed?.reason).toBe("limit.monthly_hours_quota_exceeded");
  });

  it("still charges the assertion while a meeting waits for its transcript", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: "2026-08-02T09:00:00.000Z",
      audioBytes: 10,
      recordedSeconds: TEST_LIMITS.maxMonthlyRecordedSeconds,
    });
    const fixture = createFixture({ meetings });

    expect(await start(fixture)).toBeNull();
    expect(fixture.connection.closed?.reason).toBe("limit.monthly_hours_quota_exceeded");
  });
});

describe("usage accounting", () => {
  it("writes what the recording actually cost when it is finalized", async () => {
    const fixture = createFixture();
    const sessionId = await start(fixture);
    if (!sessionId) throw new Error("the session was refused");

    await fixture.handler.handleBinary(chunk(sessionId, 0));
    await fixture.handler.handleBinary(chunk(sessionId, 1));
    await fixture.handler.handleText(
      JSON.stringify({ type: "session.end", sessionId, lastSeq: 1 }),
    );

    const usage = await fixture.meetings.readUsage(SCOPE, monthStart(NOW));
    // Byte-for-byte what object storage holds for the session, not an estimate.
    const stored = [...fixture.storage.objects.values()].reduce(
      (total, object) => total + object.byteLength,
      0,
    );
    expect(usage.storageBytes).toBe(stored);
    // `chunk()` places sequence n at audio second 2n; the offset is the start of the chunk.
    expect(usage.monthRecordedSeconds).toBe(2);
  });

  it("writes usage while the recording is still running, so a crash cannot lose it", async () => {
    const fixture = createFixture({ limits: { ...TEST_LIMITS, usageFlushChunks: 2 } });
    const sessionId = await start(fixture);
    if (!sessionId) throw new Error("the session was refused");

    await fixture.handler.handleBinary(chunk(sessionId, 0));
    expect((await fixture.meetings.readUsage(SCOPE, monthStart(NOW))).storageBytes).toBe(0);

    await fixture.handler.handleBinary(chunk(sessionId, 1));
    const usage = await fixture.meetings.readUsage(SCOPE, monthStart(NOW));
    expect(usage.storageBytes).toBeGreaterThan(0);
    expect(usage.monthRecordedSeconds).toBe(2);
  });

  it("never lowers what a session has already been charged for", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: NOW.toISOString(),
      audioBytes: 900,
      recordedSeconds: 60,
    });
    // What a reconnected connection, counting from zero again, would report.
    await meetings.recordUsage(SCOPE, "session-meeting-1", { audioBytes: 10, recordedSeconds: 1 });

    const usage = await meetings.readUsage(SCOPE, monthStart(NOW));
    expect(usage.storageBytes).toBe(900);
    expect(usage.monthRecordedSeconds).toBe(60);
  });

  it("stops counting a meeting the moment it is deleted", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: NOW.toISOString(),
      audioBytes: 900,
      recordedSeconds: 60,
    });
    await meetings.deleteMeeting(SCOPE, "meeting-1");
    expect(await meetings.readUsage(SCOPE, monthStart(NOW))).toEqual({
      storageBytes: 0,
      monthRecordedSeconds: 0,
    });
  });
});

describe("quota failures", () => {
  it("lets the recording through when the usage cannot be read", async () => {
    const meetings = new InMemoryMeetingStore();
    meetings.readUsage = async (): Promise<AccountUsage> => {
      throw new Error("database unavailable");
    };
    const fixture = createFixture({ meetings });

    // Losing a recording is worse than letting one past a quota, and every other limit still
    // applies to this session.
    expect(await start(fixture)).not.toBeNull();
  });
});

describe("per-user limits resolver", () => {
  it("enforces the limits the resolver returns for that user", async () => {
    const meetings = new InMemoryMeetingStore();
    await seedMeeting(meetings, {
      id: "meeting-1",
      createdAt: NOW.toISOString(),
      audioBytes: 5_000,
      recordedSeconds: 10,
    });
    await seedMeeting(meetings, {
      id: "meeting-2",
      createdAt: NOW.toISOString(),
      audioBytes: 5_000,
      recordedSeconds: 10,
      userId: "user-2",
    });
    // Stands in for the plan tiers to come: the same usage, two different answers.
    const resolver: UserLimitsResolver = {
      async resolve(scope) {
        return scope.userId === "user-1"
          ? { ...TEST_LIMITS, maxStorageBytes: 1_000 }
          : { ...TEST_LIMITS, maxStorageBytes: 100_000 };
      },
    };

    const limited = createFixture({ meetings, limits: resolver });
    expect(await start(limited)).toBeNull();
    expect(limited.connection.closed?.reason).toBe("limit.storage_quota_exceeded");

    // Same 5,000 stored bytes, a tier that allows more: the session is admitted.
    const generous = createFixture({ meetings, limits: resolver, userId: "user-2", idPrefix: "2" });
    expect(await start(generous)).not.toBeNull();
  });
});
