import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { MIGRATIONS as WORKER_MIGRATIONS } from "@quorum/worker/db-schema";
import { TRANSCRIPT_SCHEMA_VERSION, type AudioFormat, type Transcript } from "@quorum/shared";
import { PostgresMeetingStore } from "../src/meetings/repository.js";

/**
 * Integration tests for the SQL behind the meeting API.
 *
 * Opt-in, like the other integration tests: CI has no PostgreSQL yet. Start the compose stack
 * and run them with
 *
 *   QUORUM_INTEGRATION=1 pnpm vitest run server/test/meeting-store-integration.test.ts
 *
 * The worker's schema is applied from its own migration list rather than from a copy, so a
 * change on the worker side that breaks these read queries fails here instead of in production.
 */
const enabled = process.env.QUORUM_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_URL ?? "postgres://quorum:quorum@127.0.0.1:5432/quorum";

const WEBM_OPUS: AudioFormat = {
  codec: "opus",
  container: "webm",
  sampleRate: 48_000,
  channels: 1,
};

/** Every run works in its own tenant, so repeated runs against one database do not collide. */
const tenantId = `tenant-${Date.now()}`;
const ACME = { tenantId, userId: "user-1" };
const OTHER_TENANT = { tenantId: `${tenantId}-other`, userId: "user-1" };
const OTHER_USER = { tenantId, userId: "user-2" };

function uuid(tag: string, index: number): string {
  return `${tag.repeat(8).slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const WEEKLY = uuid("1", 1);
const RETRO = uuid("1", 2);
const OPEN = uuid("1", 3);
const FOREIGN = uuid("1", 4);
const OTHER_USERS = uuid("1", 5);

let store: PostgresMeetingStore;
let sql: postgres.Sql;

function transcriptFor(meetingId: string, transcriptId: string): Transcript {
  return {
    id: transcriptId,
    meetingId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "whisper",
    modelVersion: "large-v3",
    language: "de",
    recordedAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T10:06:00.000Z",
    speakers: [],
    segments: [
      {
        id: uuid("2", 1),
        start: 0,
        end: 30,
        text: "Guten Morgen.",
        editedText: null,
        confidence: null,
        speakerId: null,
        editedSpeakerId: null,
        language: null,
        words: null,
      },
      {
        id: uuid("2", 2),
        start: 30,
        end: 97.25,
        text: "Legen wir los.",
        editedText: null,
        confidence: null,
        speakerId: null,
        editedSpeakerId: null,
        language: null,
        words: null,
      },
    ],
  };
}

describe.skipIf(!enabled)("PostgresMeetingStore", () => {
  beforeAll(async () => {
    sql = postgres(connectionString, { max: 2 });
    await sql.begin(async (tx) => {
      for (const statement of WORKER_MIGRATIONS) await tx.unsafe(statement);
    });

    store = new PostgresMeetingStore(connectionString);
    await store.migrate();

    const seed = async (
      meetingId: string,
      scope: { tenantId: string; userId: string },
      title: string | null,
      createdAt: string,
      finalizedAt: string | null,
    ): Promise<void> => {
      await store.recordSession({
        meetingId,
        sessionId: meetingId,
        tenantId: scope.tenantId,
        userId: scope.userId,
        title,
        audioFormat: WEBM_OPUS,
        createdAt,
      });
      if (finalizedAt) await store.markFinalized(scope, meetingId, finalizedAt);
    };

    await seed(WEEKLY, ACME, "Weekly sync", "2026-08-29T10:00:00Z", "2026-08-29T10:05:00Z");
    await seed(
      RETRO,
      ACME,
      "Sprint retro 50% done",
      "2026-08-28T10:00:00Z",
      "2026-08-28T10:05:00Z",
    );
    await seed(OPEN, ACME, "Still running", "2026-08-30T10:00:00Z", null);
    await seed(
      FOREIGN,
      OTHER_TENANT,
      "Weekly sync",
      "2026-08-29T09:00:00Z",
      "2026-08-29T09:30:00Z",
    );
    await seed(
      OTHER_USERS,
      OTHER_USER,
      "Weekly sync",
      "2026-08-29T08:00:00Z",
      "2026-08-29T08:30:00Z",
    );

    // The pipeline rows are written by the worker in production; here they are inserted
    // directly, because what is under test is how the server reads them.
    const transcriptId = uuid("3", 1);
    const transcript = transcriptFor(WEEKLY, transcriptId);
    await sql`
      INSERT INTO transcripts (
        id, job_id, meeting_id, tenant_id, user_id, session_id, schema_version, model,
        model_version, language, is_active, recorded_at, created_at, transcript
      ) VALUES (
        ${transcriptId}, ${uuid("4", 1)}, ${WEEKLY}, ${tenantId}, ${"user-1"}, ${WEEKLY},
        ${TRANSCRIPT_SCHEMA_VERSION}, ${"whisper"}, ${"large-v3"}, ${"de"}, true,
        ${transcript.recordedAt}, ${transcript.createdAt},
        ${sql.json(transcript as unknown as postgres.JSONValue)}
      )
    `;
    await sql`
      INSERT INTO jobs (
        id, meeting_id, tenant_id, user_id, session_id, type, status, progress, error,
        result_id, attempt, created_at, started_at, finished_at
      ) VALUES (
        ${uuid("4", 1)}, ${WEEKLY}, ${tenantId}, ${"user-1"}, ${WEEKLY}, ${"transcribe"},
        ${"succeeded"}, ${null}, ${null}, ${transcriptId}, 0,
        ${"2026-08-29T10:05:30Z"}, ${"2026-08-29T10:05:31Z"}, ${"2026-08-29T10:06:00Z"}
      ), (
        ${uuid("4", 2)}, ${RETRO}, ${tenantId}, ${"user-1"}, ${RETRO}, ${"transcribe"},
        ${"failed"}, ${null},
        ${sql.json({ code: "AUDIO_DECODE_FAILED", message: "The audio could not be decoded." })},
        ${null}, 1, ${"2026-08-28T10:05:30Z"}, ${"2026-08-28T10:05:31Z"}, ${"2026-08-28T10:06:00Z"}
      )
    `;
  }, 30_000);

  afterAll(async () => {
    await sql`DELETE FROM jobs WHERE tenant_id LIKE ${tenantId + "%"}`;
    await sql`DELETE FROM transcripts WHERE tenant_id LIKE ${tenantId + "%"}`;
    await sql`DELETE FROM meetings WHERE tenant_id LIKE ${tenantId + "%"}`;
    await sql.end({ timeout: 5 });
    await store.close();
  });

  it("lists only the caller's own meetings, newest first", async () => {
    const meetings = await store.listMeetings(ACME);
    expect(meetings.map((meeting) => meeting.id)).toEqual([OPEN, WEEKLY, RETRO]);
  });

  it("derives the status from the pipeline rows", async () => {
    const meetings = await store.listMeetings(ACME);
    const byId = new Map(meetings.map((meeting) => [meeting.id, meeting]));

    expect(byId.get(OPEN)).toMatchObject({ status: "recording", hasAudio: false });
    // Transcript stored, no summary yet: the summarize row does not exist until the summary
    // worker starts, and the gap is reported as `summarizing` rather than as nothing.
    expect(byId.get(WEEKLY)).toMatchObject({
      status: "summarizing",
      hasAudio: true,
      language: "de",
      durationSeconds: 97.25,
    });
    expect(byId.get(RETRO)).toMatchObject({
      status: "failed",
      failure: { stage: "transcribe", code: "AUDIO_DECODE_FAILED" },
    });
  });

  it("matches titles case-insensitively and treats wildcards literally", async () => {
    expect((await store.listMeetings(ACME, { search: "WEEKLY" })).map((m) => m.id)).toEqual([
      WEEKLY,
    ]);
    // "50%" must match the literal title, not "50" followed by anything.
    expect((await store.listMeetings(ACME, { search: "50%" })).map((m) => m.id)).toEqual([RETRO]);
    expect(await store.listMeetings(ACME, { search: "retro%done" })).toEqual([]);
  });

  it("does not let a search reach across the tenant or the user boundary", async () => {
    const ids = (await store.listMeetings(ACME, { search: "Weekly" })).map((m) => m.id);
    expect(ids).toEqual([WEEKLY]);
  });

  it("paginates", async () => {
    const page = await store.listMeetings(ACME, { limit: 1, offset: 1 });
    expect(page.map((meeting) => meeting.id)).toEqual([WEEKLY]);
  });

  it("returns the transcript and the job rows in meeting detail", async () => {
    const detail = await store.findMeeting(ACME, WEEKLY);
    expect(detail?.meeting.id).toBe(WEEKLY);
    expect(detail?.transcript?.segments).toHaveLength(2);
    expect(detail?.summaries).toEqual([]);
    expect(detail?.jobs.map((job) => job.type)).toEqual(["transcribe"]);
  });

  it("reports a meeting of another tenant as missing", async () => {
    expect(await store.findMeeting(ACME, FOREIGN)).toBeNull();
  });

  it("reports a meeting of another user in the same tenant as missing", async () => {
    expect(await store.findMeeting(ACME, OTHER_USERS)).toBeNull();
  });

  it("serves the list before the worker has created its tables", async () => {
    // Start order is not coordinated: the API server may come up before the worker has applied
    // its schema. It must still serve the list rather than fail the request.
    const schema = `bare_${Date.now()}`;
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    const bare = new PostgresMeetingStore(connectionString, {
      connection: { search_path: schema },
    });
    try {
      await bare.migrate();
      await bare.recordSession({
        meetingId: uuid("5", 1),
        sessionId: uuid("5", 1),
        tenantId,
        userId: "user-1",
        title: "Before the worker started",
        audioFormat: WEBM_OPUS,
        createdAt: "2026-08-29T10:00:00Z",
      });
      const meetings = await bare.listMeetings(ACME);
      expect(meetings.map((meeting) => meeting.status)).toEqual(["recording"]);
      expect((await bare.findMeeting(ACME, uuid("5", 1)))?.jobs).toEqual([]);
    } finally {
      await bare.close();
      await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("does not finalize a session outside the caller's scope", async () => {
    await store.markFinalized(ACME, FOREIGN, "2026-08-31T10:00:00Z");
    const detail = await store.findMeeting(OTHER_TENANT, FOREIGN);
    expect(detail?.meeting.finalizedAt).toBe(new Date("2026-08-29T09:30:00Z").toISOString());
  });
});
