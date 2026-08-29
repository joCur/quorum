import { describe, expect, it } from "vitest";
import { AUDIO_FORMAT, SESSION_ID, freshBuffer } from "./helpers";
import type { BufferedSession } from "../src/features/recording/chunk-buffer";

function session(overrides: Partial<BufferedSession> = {}): BufferedSession {
  return {
    sessionId: SESSION_ID,
    meetingTitle: null,
    audioFormat: AUDIO_FORMAT,
    startedAt: "2026-08-29T10:00:00.000Z",
    lastSeq: -1,
    persistedSeq: -1,
    finalized: false,
    ...overrides,
  };
}

async function seed(count: number) {
  const buffer = await freshBuffer();
  await buffer.putSession(session());
  for (let seq = 0; seq < count; seq += 1) {
    await buffer.appendChunk({
      sessionId: SESSION_ID,
      seq,
      timestampOffset: seq,
      duration: 1,
      payload: new Uint8Array([seq]).buffer,
    });
  }
  return buffer;
}

describe("chunk buffer", () => {
  it("returns chunks in sequence order from a given sequence number", async () => {
    const buffer = await seed(5);
    const fromTwo = await buffer.chunksFrom(SESSION_ID, 2);
    expect(fromTwo.map((chunk) => chunk.seq)).toEqual([2, 3, 4]);
  });

  it("tracks the highest sequence number handed to it", async () => {
    const buffer = await seed(3);
    expect((await buffer.getSession(SESSION_ID))?.lastSeq).toBe(2);
  });

  it("evicts only what the server acknowledged", async () => {
    const buffer = await seed(5);
    await buffer.evictThrough(SESSION_ID, 2);

    const remaining = await buffer.chunksFrom(SESSION_ID, 0);
    expect(remaining.map((chunk) => chunk.seq)).toEqual([3, 4]);
    expect((await buffer.getSession(SESSION_ID))?.persistedSeq).toBe(2);
  });

  it("never moves persistedSeq backwards on a late acknowledgement", async () => {
    const buffer = await seed(5);
    await buffer.evictThrough(SESSION_ID, 3);
    await buffer.evictThrough(SESSION_ID, 1);
    expect((await buffer.getSession(SESSION_ID))?.persistedSeq).toBe(3);
  });

  it("reports how much unacknowledged audio is held locally", async () => {
    const buffer = await seed(4);
    await buffer.evictThrough(SESSION_ID, 0);

    const stats = await buffer.pendingStats(SESSION_ID);
    expect(stats.count).toBe(3);
    expect(stats.durationSeconds).toBe(3);
    expect(stats.bytes).toBe(3);
  });

  it("lists sessions that never reached session.finalized", async () => {
    const buffer = await seed(2);
    expect((await buffer.listUnfinishedSessions()).map((entry) => entry.sessionId)).toEqual([
      SESSION_ID,
    ]);

    await buffer.putSession(session({ finalized: true }));
    expect(await buffer.listUnfinishedSessions()).toEqual([]);
  });

  it("removes a session together with all of its chunks", async () => {
    const buffer = await seed(3);
    await buffer.deleteSession(SESSION_ID);

    expect(await buffer.getSession(SESSION_ID)).toBeNull();
    expect(await buffer.chunksFrom(SESSION_ID, 0)).toEqual([]);
  });
});
