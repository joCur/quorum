import { describe, expect, it } from "vitest";
import { RecordingSessionHandler } from "../src/recording/session.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import type { MeetingRegistry } from "../src/recording/types.js";
import { FakeConnection, WEBM_OPUS, chunk, idSequence } from "./helpers.js";

const SCOPE = { tenantId: "tenant-acme", userId: "user-1" };

interface Harness {
  connection: FakeConnection;
  handler: RecordingSessionHandler;
  meetings: InMemoryMeetingStore;
  warnings: string[];
}

function harness(registry?: MeetingRegistry): Harness {
  const connection = new FakeConnection();
  const meetings = new InMemoryMeetingStore();
  const warnings: string[] = [];
  const handler = new RecordingSessionHandler(connection, {
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    meetings: registry ?? meetings,
    context: SCOPE,
    newId: idSequence(),
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    logger: {
      warn(_details, message) {
        warnings.push(message);
      },
    },
  });
  return { connection, handler, meetings, warnings };
}

async function record(test: Harness): Promise<string> {
  await test.handler.handleText(
    JSON.stringify({
      type: "session.start",
      meetingTitle: "Weekly sync",
      audioFormat: WEBM_OPUS,
      clientInfo: { platform: "web-desktop", userAgent: "vitest" },
    }),
  );
  const sessionId = test.connection.last("session.ready")?.sessionId;
  if (!sessionId) throw new Error("session.ready was not sent");
  return sessionId;
}

describe("meeting indexing from the recording endpoint", () => {
  it("lists a meeting as recording as soon as the session starts", async () => {
    const test = harness();
    await record(test);

    const meetings = await test.meetings.listMeetings(SCOPE);
    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({
      title: "Weekly sync",
      status: "recording",
      hasAudio: false,
      finalizedAt: null,
    });
  });

  it("marks the meeting finalized once the recording ends", async () => {
    const test = harness();
    const sessionId = await record(test);
    await test.handler.handleBinary(chunk(sessionId, 0));
    await test.handler.handleText(JSON.stringify({ type: "session.end", sessionId, lastSeq: 0 }));

    const meetings = await test.meetings.listMeetings(SCOPE);
    // With the audio finalized and no job row yet, the meeting is waiting in the queue — the
    // state the transcription worker has not caught up with yet.
    expect(meetings[0]).toMatchObject({ status: "queued", hasAudio: true });
    expect(meetings[0]?.finalizedAt).not.toBeNull();
  });

  it("does not list the meeting for another tenant", async () => {
    const test = harness();
    await record(test);
    expect(
      await test.meetings.listMeetings({ tenantId: "tenant-globex", userId: "user-1" }),
    ).toEqual([]);
  });

  it("keeps recording when the meeting index is unavailable", async () => {
    // Capture integrity outranks listability: a database blip must never stop a recording.
    const failing: MeetingRegistry = {
      async recordSession() {
        throw new Error("database unavailable");
      },
      async markFinalized() {
        throw new Error("database unavailable");
      },
    };
    const test = harness(failing);
    const sessionId = await record(test);
    await test.handler.handleBinary(chunk(sessionId, 0));

    expect(test.connection.closed).toBeNull();
    expect(test.connection.last("chunk.ack")?.persistedSeq).toBe(0);
    expect(test.warnings.length).toBeGreaterThan(0);
  });

  it("repairs a missing index entry when the recording is finalized", async () => {
    const test = harness();
    let failNext = true;
    const flaky: MeetingRegistry = {
      async recordSession(input) {
        if (failNext) {
          failNext = false;
          throw new Error("database unavailable");
        }
        await test.meetings.recordSession(input);
      },
      markFinalized: (scope, sessionId, at) => test.meetings.markFinalized(scope, sessionId, at),
    };
    const repaired = harness(flaky);
    const sessionId = await record(repaired);
    expect(await test.meetings.listMeetings(SCOPE)).toEqual([]);

    await repaired.handler.handleBinary(chunk(sessionId, 0));
    await repaired.handler.handleText(
      JSON.stringify({ type: "session.end", sessionId, lastSeq: 0 }),
    );

    const meetings = await test.meetings.listMeetings(SCOPE);
    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({ status: "queued", hasAudio: true });
  });
});
