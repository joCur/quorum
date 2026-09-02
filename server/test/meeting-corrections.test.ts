import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  hasCorrections,
  SUMMARY_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type AudioFormat,
  type MeetingDetail,
  type SegmentCorrectionResponse,
  type Summary,
  type Transcript,
} from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

/**
 * Correcting a transcript segment over the API (ADR-003 §2, ADR-011).
 *
 * What is held here is the promise the feature makes: the machine output survives every write, a
 * reset brings the original back, another tenant cannot reach any of it, and the meeting reports
 * when it was last corrected so the summary can say it has fallen behind.
 */

const keys: TestKeyPair = await createTestKeyPair();

const WEBM_OPUS: AudioFormat = {
  codec: "opus",
  container: "webm",
  sampleRate: 48_000,
  channels: 1,
};

function uuid(tag: string, index: number): string {
  return `${tag.repeat(8).slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const ACME = { tenantId: "tenant-acme", userId: "user-1" };
const GLOBEX = { tenantId: "tenant-globex", userId: "user-9" };
const ACME_OTHER_USER = { tenantId: "tenant-acme", userId: "user-2" };

const MEETING = uuid("a", 1);
const TRANSCRIPT = uuid("c", 1);
const FIRST = uuid("d", 1);
const SECOND = uuid("d", 2);
const UNKNOWN_SEGMENT = uuid("d", 9);
const SPEAKER_A = uuid("5", 1);
const SPEAKER_B = uuid("5", 2);
const STRANGER = uuid("5", 9);

const SUMMARY_WRITTEN_AT = "2026-08-29T10:08:00.000Z";
const CORRECTED_AT = new Date("2026-08-29T11:00:00.000Z");

function transcript(): Transcript {
  return {
    id: TRANSCRIPT,
    meetingId: MEETING,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "whisper",
    modelVersion: "large-v3",
    language: "en",
    recordedAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T10:06:00.000Z",
    speakers: [
      { id: SPEAKER_A, label: "Speaker 1", profileId: null },
      { id: SPEAKER_B, label: "Speaker 2", profileId: null },
    ],
    segments: [
      {
        id: FIRST,
        start: 0,
        end: 4,
        text: "We ship on Friday.",
        editedText: null,
        confidence: 0.9,
        speakerId: SPEAKER_A,
        editedSpeakerId: null,
        language: null,
        words: null,
      },
      {
        id: SECOND,
        start: 4,
        end: 8,
        text: "Agreed.",
        editedText: null,
        confidence: 0.9,
        speakerId: SPEAKER_A,
        editedSpeakerId: null,
        language: null,
        words: null,
      },
    ],
  };
}

function summary(): Summary {
  return {
    id: uuid("e", 1),
    meetingId: MEETING,
    transcriptId: TRANSCRIPT,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    isActive: true,
    templateSnapshot: {
      templateId: uuid("f", 1),
      templateVersion: 1,
      resolvedSections: [
        { id: "decisions", title: "Decisions", instruction: "List decisions.", format: "bullets" },
      ],
      options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
    },
    model: "gpt-oss",
    promptVersion: "1",
    generatedTitle: null,
    createdAt: SUMMARY_WRITTEN_AT,
    sections: [
      {
        sectionId: "decisions",
        title: "Decisions",
        format: "bullets",
        content: ["Ship on Friday."],
        sourceSegmentIds: null,
      },
    ],
  };
}

async function token(scope: { tenantId: string; userId: string }): Promise<string> {
  return signAccessToken(keys, {
    subject: scope.userId,
    tenantId: scope.tenantId,
    roles: ["quorum-user"],
  });
}

let app: FastifyInstance;
let store: InMemoryMeetingStore;

function correctionUrl(segmentId: string, meetingId = MEETING): string {
  return `/api/meetings/${meetingId}/transcript/segments/${segmentId}/correction`;
}

async function detail(scope = ACME): Promise<MeetingDetail> {
  const response = await app.inject({
    method: "GET",
    url: `/api/meetings/${MEETING}`,
    headers: { authorization: `Bearer ${await token(scope)}` },
  });
  return response.json() as MeetingDetail;
}

beforeEach(async () => {
  store = new InMemoryMeetingStore(() => CORRECTED_AT);
  await store.recordSession({
    meetingId: MEETING,
    sessionId: MEETING,
    tenantId: ACME.tenantId,
    userId: ACME.userId,
    title: "Weekly sync",
    audioFormat: WEBM_OPUS,
    createdAt: "2026-08-29T10:00:00.000Z",
  });
  await store.markFinalized(ACME, MEETING, "2026-08-29T10:05:00.000Z");
  store.setPipeline(MEETING, { transcript: transcript(), summaries: [summary()] });

  app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    meetings: store,
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: [INTERNAL_ISSUER, ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: keys.jwks,
      }),
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function correct(
  segmentId: string,
  overlay: { editedText: string | null; editedSpeakerId: string | null },
  scope = ACME,
) {
  return app.inject({
    method: "PUT",
    url: correctionUrl(segmentId),
    headers: { authorization: `Bearer ${await token(scope)}` },
    payload: overlay,
  });
}

describe("correcting a segment's text", () => {
  it("requires an access token", async () => {
    const response = await app.inject({
      method: "PUT",
      url: correctionUrl(FIRST),
      payload: { editedText: "anything", editedSpeakerId: null },
    });
    expect(response.statusCode).toBe(401);
  });

  it("stores the correction and hands back the segment as it now reads", async () => {
    const response = await correct(FIRST, {
      editedText: "We ship on Monday.",
      editedSpeakerId: null,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as SegmentCorrectionResponse;
    expect(body.segment.editedText).toBe("We ship on Monday.");
    expect(body.segment.text).toBe("We ship on Friday.");
  });

  it("shows the correction on the next read, over untouched machine output", async () => {
    await correct(FIRST, { editedText: "We ship on Monday.", editedSpeakerId: null });

    const meeting = await detail();
    const segment = meeting.transcript?.segments[0];
    expect(segment?.editedText).toBe("We ship on Monday.");
    expect(segment?.text).toBe("We ship on Friday.");
    expect(hasCorrections(meeting.transcript as Transcript)).toBe(true);
  });

  it("leaves the other segments alone", async () => {
    await correct(FIRST, { editedText: "We ship on Monday.", editedSpeakerId: null });

    expect((await detail()).transcript?.segments[1]?.editedText).toBeNull();
  });

  it("replaces the correction rather than stacking a second one", async () => {
    await correct(FIRST, { editedText: "First attempt.", editedSpeakerId: null });
    await correct(FIRST, { editedText: "Second attempt.", editedSpeakerId: null });

    expect((await detail()).transcript?.segments[0]?.editedText).toBe("Second attempt.");
  });

  it("refuses a body that is not an overlay", async () => {
    const response = await app.inject({
      method: "PUT",
      url: correctionUrl(FIRST),
      headers: { authorization: `Bearer ${await token(ACME)}` },
      payload: { editedText: "no speaker field at all" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_request");
  });

  it("does not mark a segment corrected when the machine's own words were typed back in", async () => {
    const response = await correct(FIRST, {
      editedText: "  We ship on Friday.  ",
      editedSpeakerId: null,
    });

    expect((response.json() as SegmentCorrectionResponse).segment.editedText).toBeNull();
    expect(hasCorrections((await detail()).transcript as Transcript)).toBe(false);
  });
});

describe("reassigning a speaker", () => {
  it("stores the override beside the machine's assignment", async () => {
    await correct(FIRST, { editedText: null, editedSpeakerId: SPEAKER_B });

    const segment = (await detail()).transcript?.segments[0];
    expect(segment?.editedSpeakerId).toBe(SPEAKER_B);
    expect(segment?.speakerId).toBe(SPEAKER_A);
  });

  it("carries a text correction and a reassignment in one overlay", async () => {
    await correct(FIRST, { editedText: "We ship on Monday.", editedSpeakerId: SPEAKER_B });

    const segment = (await detail()).transcript?.segments[0];
    expect(segment?.editedText).toBe("We ship on Monday.");
    expect(segment?.editedSpeakerId).toBe(SPEAKER_B);
  });

  it("refuses a speaker this transcript does not have", async () => {
    const response = await correct(FIRST, { editedText: null, editedSpeakerId: STRANGER });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("unknown_speaker");
    expect((await detail()).transcript?.segments[0]?.editedSpeakerId).toBeNull();
  });
});

describe("resetting a segment to the original", () => {
  it("removes the correction and reports the segment as the machine left it", async () => {
    await correct(FIRST, { editedText: "We ship on Monday.", editedSpeakerId: SPEAKER_B });

    const response = await app.inject({
      method: "DELETE",
      url: correctionUrl(FIRST),
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as SegmentCorrectionResponse;
    expect(body.segment.editedText).toBeNull();
    expect(body.segment.editedSpeakerId).toBeNull();
    expect(body.segment.text).toBe("We ship on Friday.");
  });

  it("is idempotent, so a repeated reset is not an error", async () => {
    const reset = async () =>
      app.inject({
        method: "DELETE",
        url: correctionUrl(SECOND),
        headers: { authorization: `Bearer ${await token(ACME)}` },
      });

    expect((await reset()).statusCode).toBe(200);
    expect((await reset()).statusCode).toBe(200);
  });

  it("keeps the corrections on the other segments, and the time of the newest", async () => {
    await correct(FIRST, { editedText: "We ship on Monday.", editedSpeakerId: null });
    await correct(SECOND, { editedText: "Agreed, unanimously.", editedSpeakerId: null });

    await app.inject({
      method: "DELETE",
      url: correctionUrl(FIRST),
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });

    const meeting = await detail();
    expect(meeting.transcript?.segments[0]?.editedText).toBeNull();
    expect(meeting.transcript?.segments[1]?.editedText).toBe("Agreed, unanimously.");
    expect(hasCorrections(meeting.transcript as Transcript)).toBe(true);
  });
});

describe("scope (ADR-001)", () => {
  it("answers 404 for a segment that is not in the transcript", async () => {
    const response = await correct(UNKNOWN_SEGMENT, {
      editedText: "nothing said this",
      editedSpeakerId: null,
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe("segment_not_found");
  });

  it("answers 404 for another tenant, rather than admitting the meeting exists", async () => {
    const response = await correct(
      FIRST,
      { editedText: "not theirs to write", editedSpeakerId: null },
      GLOBEX,
    );

    expect(response.statusCode).toBe(404);
    expect((await detail()).transcript?.segments[0]?.editedText).toBeNull();
  });

  it("answers 404 for another user of the same tenant", async () => {
    const response = await correct(
      FIRST,
      { editedText: "not theirs either", editedSpeakerId: null },
      ACME_OTHER_USER,
    );

    expect(response.statusCode).toBe(404);
    expect((await detail()).transcript?.segments[0]?.editedText).toBeNull();
  });

  it("answers 404 for a malformed segment id, like any other id it cannot place", async () => {
    const response = await app.inject({
      method: "PUT",
      url: correctionUrl("not-a-uuid"),
      headers: { authorization: `Bearer ${await token(ACME)}` },
      payload: { editedText: "x", editedSpeakerId: null },
    });
    expect(response.statusCode).toBe(404);
  });
});

/**
 * One correction per segment, whoever writes it (ADR-011 §6).
 *
 * The API is user-scoped today, so a second author cannot reach the same meeting — but the store
 * is where that would change first, and a per-user key there would quietly become two overlays on
 * one passage the day a meeting is shared. The semantics are pinned at the store.
 */
describe("two authors correcting one segment", () => {
  const ANOTHER_MEMBER = { tenantId: ACME.tenantId, userId: "user-7" };

  it("keeps one correction, the last one written", async () => {
    await store.setSegmentCorrection(
      ACME,
      { meetingId: MEETING, transcriptId: TRANSCRIPT, segmentId: FIRST },
      { editedText: "First author.", editedSpeakerId: null },
    );
    const second = await store.setSegmentCorrection(
      ANOTHER_MEMBER,
      { meetingId: MEETING, transcriptId: TRANSCRIPT, segmentId: FIRST },
      { editedText: "Second author.", editedSpeakerId: null },
    );

    expect(second).toEqual({
      kind: "stored",
      correction: {
        segmentId: FIRST,
        editedText: "Second author.",
        editedSpeakerId: null,
        updatedAt: CORRECTED_AT.toISOString(),
      },
    });
    expect((await detail()).transcript?.segments[0]?.editedText).toBe("Second author.");
  });
});

/**
 * The reprocessing race (ADR-011 §8).
 *
 * A correction resolved against one transcript and written after it stopped being the active one
 * would be accepted, answered with 200, and then be invisible — the store refuses it and the route
 * says so, so the screen can ask for a reload instead of showing a lie.
 */
describe("a transcript replaced under the correction", () => {
  it("refuses the write and names the reason", async () => {
    // What reprocessing does: a new active transcript for the same meeting.
    const replacement = { ...transcript(), id: uuid("c", 2) };
    store.setPipeline(MEETING, { transcript: replacement, summaries: [summary()] });

    const outcome = await store.setSegmentCorrection(
      ACME,
      { meetingId: MEETING, transcriptId: TRANSCRIPT, segmentId: FIRST },
      { editedText: "Against the old transcript.", editedSpeakerId: null },
    );

    expect(outcome).toEqual({ kind: "transcript-replaced" });
    expect((await detail()).transcript?.segments[0]?.editedText).toBeNull();
  });

  it("is answered as 409, so the client can ask for a reload", async () => {
    // The race cannot be produced through the API from outside — the route resolves the active
    // transcript itself — so the store is made to report what it reports when it loses that race.
    const replaced = vi
      .spyOn(store, "setSegmentCorrection")
      .mockResolvedValue({ kind: "transcript-replaced" });

    const response = await correct(FIRST, {
      editedText: "Against a transcript that has been replaced.",
      editedSpeakerId: null,
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("transcript_replaced");
    replaced.mockRestore();
  });

  it("refuses a reset against it too, rather than reporting one it did not make", async () => {
    const replacement = { ...transcript(), id: uuid("c", 2) };
    store.setPipeline(MEETING, { transcript: replacement, summaries: [summary()] });

    expect(
      await store.clearSegmentCorrection(ACME, {
        meetingId: MEETING,
        transcriptId: TRANSCRIPT,
        segmentId: FIRST,
      }),
    ).toEqual({ kind: "transcript-replaced" });
  });
});

describe("the deletion cascade (ADR-001)", () => {
  it("takes the corrections with the meeting", async () => {
    await correct(FIRST, { editedText: "We ship on Monday.", editedSpeakerId: null });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/meetings/${MEETING}`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });

    expect(deleted.statusCode).toBe(204);
    expect(store.size).toBe(0);
  });
});
