import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PgBoss } from "pg-boss";
import { MIGRATIONS as WORKER_MIGRATIONS } from "@quorum/worker/db-schema";
import { TRANSCRIPT_SCHEMA_VERSION, type AudioFormat, type Transcript } from "@quorum/shared";
import { PostgresMeetingStore } from "../src/meetings/repository.js";
import { TRANSCRIBE_QUEUE } from "../src/recording/queue/pg-boss.js";

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

/** Decoded length of the weekly sync's audio, far above the duration its client asserted. */
const TRANSCRIBED_SECONDS = 3600;

let store: PostgresMeetingStore;
let sql: postgres.Sql;
let boss: PgBoss;

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
        model_version, language, is_active, recorded_at, created_at, duration_seconds, transcript
      ) VALUES (
        ${transcriptId}, ${uuid("4", 1)}, ${WEEKLY}, ${tenantId}, ${"user-1"}, ${WEEKLY},
        ${TRANSCRIPT_SCHEMA_VERSION}, ${"whisper"}, ${"large-v3"}, ${"de"}, true,
        ${transcript.recordedAt}, ${transcript.createdAt}, ${TRANSCRIBED_SECONDS},
        ${sql.json(transcript as unknown as postgres.JSONValue)}
      )
    `;

    // What each meeting claimed while it was recording. The weekly sync claimed a fraction of
    // what its audio turned out to contain; the others have no transcript to check them against.
    await store.recordUsage(ACME, WEEKLY, { audioBytes: 1_000, recordedSeconds: 60 });
    await store.recordUsage(ACME, RETRO, { audioBytes: 2_000, recordedSeconds: 900 });
    await store.recordUsage(ACME, OPEN, { audioBytes: 500, recordedSeconds: 120 });
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
    await sql`DELETE FROM summaries WHERE tenant_id LIKE ${tenantId + "%"}`;
    await sql`DELETE FROM transcripts WHERE tenant_id LIKE ${tenantId + "%"}`;
    await sql`DELETE FROM meetings WHERE tenant_id LIKE ${tenantId + "%"}`;
    await sql.end({ timeout: 5 });
    await store.close();
  });

  describe("usage accounting", () => {
    it("charges a transcribed meeting for its audio and an untranscribed one for its claim", async () => {
      const usage = await store.readUsage(ACME, "2026-08-01T00:00:00Z");

      expect(usage.storageBytes).toBe(3_500);
      // The weekly sync counts as the hour its audio really was, not as the minute it claimed.
      expect(usage.monthRecordedSeconds).toBe(TRANSCRIBED_SECONDS + 900 + 120);
    });

    it("counts nothing for a user with no meetings of their own", async () => {
      const usage = await store.readUsage({ tenantId, userId: "user-3" }, "2026-08-01T00:00:00Z");

      expect(usage).toEqual({ storageBytes: 0, monthRecordedSeconds: 0 });
    });

    it("shows the duration it bills", async () => {
      // The weekly sync's segments stop at 42 seconds while its audio was measured at an hour —
      // the shape a silence-filtered recording has. The list must not report the shorter one.
      const [, weekly] = await store.listMeetings(ACME);
      expect(weekly?.id).toBe(WEEKLY);
      expect(weekly?.durationSeconds).toBe(TRANSCRIBED_SECONDS);
    });

    it("does not give a measurement back when a newer transcript has none", async () => {
      // Reprocessing: a second, active transcript whose backend reported no duration.
      const reprocessed = uuid("6", 1);
      const transcript = transcriptFor(WEEKLY, reprocessed);
      await sql`UPDATE transcripts SET is_active = false WHERE meeting_id = ${WEEKLY}`;
      await sql`
        INSERT INTO transcripts (
          id, job_id, meeting_id, tenant_id, user_id, session_id, schema_version, model,
          model_version, language, is_active, recorded_at, created_at, duration_seconds, transcript
        ) VALUES (
          ${reprocessed}, ${uuid("6", 2)}, ${WEEKLY}, ${tenantId}, ${"user-1"}, ${WEEKLY},
          ${TRANSCRIPT_SCHEMA_VERSION}, ${"whisper"}, ${"large-v3"}, ${"de"}, true,
          ${transcript.recordedAt}, ${"2026-08-29T11:00:00Z"}, ${null},
          ${sql.json(transcript as unknown as postgres.JSONValue)}
        )
      `;
      try {
        const usage = await store.readUsage(ACME, "2026-08-01T00:00:00Z");
        // Still the measured hour, not the minute the client claimed.
        expect(usage.monthRecordedSeconds).toBe(TRANSCRIBED_SECONDS + 900 + 120);
      } finally {
        await sql`DELETE FROM transcripts WHERE id = ${reprocessed}`;
        await sql`UPDATE transcripts SET is_active = true WHERE meeting_id = ${WEEKLY}`;
      }
    });
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
      // The measured length of the audio, which is also what the quota charges — not the 97.25
      // seconds at which this transcript's last segment ends.
      durationSeconds: TRANSCRIBED_SECONDS,
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

  describe("deletion cascade", () => {
    const DOOMED = uuid("6", 1);
    const DOOMED_TRANSCRIPT = uuid("6", 2);
    const DOOMED_JOB = uuid("6", 3);
    const DOOMED_SUMMARY = uuid("6", 4);

    beforeAll(async () => {
      // A real queued job, enqueued through pg-boss itself: the cascade has to remove work that
      // pg-boss actually wrote, not work shaped the way this test imagines it.
      boss = new PgBoss({ connectionString });
      await boss.start();
      await boss.createQueue(TRANSCRIBE_QUEUE);
      await boss.send(TRANSCRIBE_QUEUE, {
        job: { id: uuid("6", 7), meetingId: DOOMED, type: "transcribe", status: "queued" },
        tenantId,
        userId: "user-1",
        sessionId: DOOMED,
      });

      await store.recordSession({
        meetingId: DOOMED,
        sessionId: DOOMED,
        tenantId,
        userId: "user-1",
        title: "To be deleted",
        audioFormat: WEBM_OPUS,
        createdAt: "2026-08-25T10:00:00Z",
      });
      await store.markFinalized(ACME, DOOMED, "2026-08-25T10:05:00Z");

      const transcript = transcriptFor(DOOMED, DOOMED_TRANSCRIPT);
      await sql`
        INSERT INTO transcripts (
          id, job_id, meeting_id, tenant_id, user_id, session_id, schema_version, model,
          model_version, language, is_active, recorded_at, created_at, transcript
        ) VALUES (
          ${DOOMED_TRANSCRIPT}, ${DOOMED_JOB}, ${DOOMED}, ${tenantId}, ${"user-1"}, ${DOOMED},
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
          ${DOOMED_JOB}, ${DOOMED}, ${tenantId}, ${"user-1"}, ${DOOMED}, ${"transcribe"},
          ${"succeeded"}, ${null}, ${null}, ${DOOMED_TRANSCRIPT}, 0,
          ${"2026-08-25T10:05:30Z"}, ${"2026-08-25T10:05:31Z"}, ${"2026-08-25T10:06:00Z"}
        )
      `;
      await sql`
        INSERT INTO summaries (
          id, job_id, meeting_id, transcript_id, tenant_id, user_id, session_id, schema_version,
          template_id, template_version, model, prompt_version, is_active, created_at, summary
        ) VALUES (
          ${DOOMED_SUMMARY}, ${uuid("6", 5)}, ${DOOMED}, ${DOOMED_TRANSCRIPT}, ${tenantId},
          ${"user-1"}, ${DOOMED}, 1, ${uuid("6", 6)}, 1, ${"gpt-oss"}, ${"1"}, true,
          ${"2026-08-25T10:08:00Z"}, ${sql.json({ id: DOOMED_SUMMARY })}
        )
      `;
    }, 30_000);

    afterAll(async () => {
      await boss.stop();
    });

    it("refuses to delete a meeting outside the caller's scope", async () => {
      expect(await store.deleteMeeting(OTHER_TENANT, DOOMED)).toBe(false);
      expect(await store.deleteMeeting(OTHER_USER, DOOMED)).toBe(false);
      expect(await store.findMeeting(ACME, DOOMED)).not.toBeNull();
    });

    it("leaves no row behind in any table", async () => {
      const queuedBefore = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pgboss.job
         WHERE data->'job'->>'meetingId' = ${DOOMED}
      `;
      // Guards the assertion below against passing because there was never anything to delete.
      expect(queuedBefore[0]?.count).toBe(1);

      expect(await store.deleteMeeting(ACME, DOOMED)).toBe(true);

      // `meetings` keys the meeting by `id`, every derived table by `meeting_id`.
      for (const [table, column] of [
        ["meetings", "id"],
        ["transcripts", "meeting_id"],
        ["summaries", "meeting_id"],
        ["jobs", "meeting_id"],
      ] as const) {
        const rows = (await sql.unsafe(
          `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`,
          [DOOMED],
        )) as unknown as { count: number }[];
        expect(rows[0]?.count, `${table} still has rows`).toBe(0);
      }
      const queued = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pgboss.job
         WHERE data->'job'->>'meetingId' = ${DOOMED}
      `;
      // Work left in the queue would be picked up after the delete and write a fresh transcript
      // for a meeting that no longer exists.
      expect(queued[0]?.count).toBe(0);
    });

    it("is idempotent", async () => {
      expect(await store.deleteMeeting(ACME, DOOMED)).toBe(false);
    });

    it("left the other meetings alone", async () => {
      expect((await store.listMeetings(ACME)).map((meeting) => meeting.id)).toEqual([
        OPEN,
        WEEKLY,
        RETRO,
      ]);
      expect((await store.findMeeting(ACME, WEEKLY))?.transcript).not.toBeNull();
    });
  });

  /**
   * Handing a job back to the queue — the half of the retry endpoint that only real PostgreSQL
   * and a real pg-boss can exercise.
   *
   * What is at stake is a duplicate transcription. `singletonKey` deduplicates nothing under the
   * `standard` policy both queues run on, and the worker writes `failed` into the job row on every
   * attempt including the ones pg-boss is still going to repeat by itself — so nothing but the
   * queue itself can answer whether a job is already going to run.
   */
  describe("handing a failed job back to the queue", () => {
    const RETRIED = uuid("7", 1);
    const RETRIED_JOB = uuid("7", 2);
    const QUEUES = { name: TRANSCRIBE_QUEUE, deadLetter: `${TRANSCRIBE_QUEUE}-dead-letter` };
    let retryBoss: PgBoss;

    const payloadFor = (jobId: string) => ({
      job: { id: jobId, meetingId: RETRIED, type: "transcribe", status: "queued" },
      tenantId,
      userId: "user-1",
      sessionId: RETRIED,
    });

    /** Puts the job row back into the failure every case starts from. */
    const resetJobRow = async (): Promise<void> => {
      await sql`DELETE FROM jobs WHERE id = ${RETRIED_JOB}`;
      await sql`
        INSERT INTO jobs (
          id, meeting_id, tenant_id, user_id, session_id, type, status, progress, error,
          result_id, attempt, created_at, started_at, finished_at, updated_at
        ) VALUES (
          ${RETRIED_JOB}, ${RETRIED}, ${tenantId}, ${"user-1"}, ${RETRIED}, ${"transcribe"},
          ${"failed"}, ${null},
          ${sql.json({ code: "TRANSCRIPTION_REJECTED", message: "backend answered 404" })},
          ${null}, 3, ${"2026-08-26T10:05:30Z"}, ${"2026-08-26T10:05:31Z"},
          ${"2026-08-26T10:06:00Z"}, now()
        )
      `;
    };

    const clearQueue = async (): Promise<void> => {
      await sql`DELETE FROM pgboss.job WHERE data->'job'->>'meetingId' = ${RETRIED}`;
    };

    beforeAll(async () => {
      retryBoss = new PgBoss({ connectionString });
      await retryBoss.start();
      await retryBoss.createQueue(QUEUES.name);
      await retryBoss.createQueue(QUEUES.deadLetter);

      await store.recordSession({
        meetingId: RETRIED,
        sessionId: RETRIED,
        tenantId,
        userId: "user-1",
        title: "Failed once",
        audioFormat: WEBM_OPUS,
        createdAt: "2026-08-26T10:00:00Z",
      });
      await store.markFinalized(ACME, RETRIED, "2026-08-26T10:05:00Z");
    }, 30_000);

    afterAll(async () => {
      await retryBoss.stop();
      await clearQueue();
    });

    beforeEach(async () => {
      await clearQueue();
      await resetJobRow();
    });

    it("moves the row and enqueues, as one step", async () => {
      const outcome = await store.requeueFailedJob(ACME, {
        meetingId: RETRIED,
        jobId: RETRIED_JOB,
        queue: QUEUES,
        enqueue: async () => {
          await retryBoss.send(QUEUES.name, payloadFor(RETRIED_JOB));
        },
      });
      expect(outcome).toBe("requeued");

      const rows = await sql<{ status: string; attempt: number; error: unknown }[]>`
        SELECT status, attempt, error FROM jobs WHERE id = ${RETRIED_JOB}
      `;
      expect(rows[0]).toMatchObject({ status: "queued", attempt: 0, error: null });
      expect(await liveEntries(RETRIED_JOB)).toBe(1);
      // And the meeting says so, which is what the client reads to stop offering the action.
      expect((await store.findMeeting(ACME, RETRIED))?.meeting.status).toBe("queued");
    });

    it("refuses while the queue still holds an entry for the job", async () => {
      // The trap: a `failed` row whose job pg-boss is going to repeat on its own after a backoff.
      await retryBoss.send(QUEUES.name, payloadFor(RETRIED_JOB));

      let enqueued = false;
      const outcome = await store.requeueFailedJob(ACME, {
        meetingId: RETRIED,
        jobId: RETRIED_JOB,
        queue: QUEUES,
        enqueue: async () => {
          enqueued = true;
        },
      });

      expect(outcome).toBe("in-progress");
      expect(enqueued).toBe(false);
      expect(await liveEntries(RETRIED_JOB)).toBe(1);
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM jobs WHERE id = ${RETRIED_JOB}
      `;
      expect(rows[0]?.status).toBe("failed");
    });

    it("does not mistake the parked attempt on the dead-letter queue for a live one", async () => {
      await retryBoss.send(QUEUES.deadLetter, payloadFor(RETRIED_JOB));

      const outcome = await store.requeueFailedJob(ACME, {
        meetingId: RETRIED,
        jobId: RETRIED_JOB,
        queue: QUEUES,
        enqueue: async () => {
          await retryBoss.send(QUEUES.name, payloadFor(RETRIED_JOB));
        },
      });

      expect(outcome).toBe("requeued");
      // And the parked entry is gone, so the next operator bulk redrive does not replay a job
      // this user has already had run again.
      const parked = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pgboss.job
         WHERE name = ${QUEUES.deadLetter} AND data->'job'->>'id' = ${RETRIED_JOB}
      `;
      expect(parked[0]?.count).toBe(0);
    });

    it("rolls the row back when the enqueue fails", async () => {
      await expect(
        store.requeueFailedJob(ACME, {
          meetingId: RETRIED,
          jobId: RETRIED_JOB,
          queue: QUEUES,
          enqueue: async () => {
            throw new Error("the queue said no");
          },
        }),
      ).rejects.toThrow("the queue said no");

      // No half state: a `queued` row with nothing behind it would leave the meeting waiting for
      // a run nobody started.
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM jobs WHERE id = ${RETRIED_JOB}
      `;
      expect(rows[0]?.status).toBe("failed");
      expect(await liveEntries(RETRIED_JOB)).toBe(0);
    });

    it("refuses a job that has since succeeded", async () => {
      await sql`UPDATE jobs SET status = 'succeeded' WHERE id = ${RETRIED_JOB}`;
      const outcome = await store.requeueFailedJob(ACME, {
        meetingId: RETRIED,
        jobId: RETRIED_JOB,
        queue: QUEUES,
        enqueue: async () => {
          throw new Error("must not be reached");
        },
      });
      expect(outcome).toBe("nothing-to-retry");
    });

    it("refuses a job outside the caller's scope", async () => {
      for (const scope of [OTHER_TENANT, OTHER_USER]) {
        const outcome = await store.requeueFailedJob(scope, {
          meetingId: RETRIED,
          jobId: RETRIED_JOB,
          queue: QUEUES,
          enqueue: async () => {
            throw new Error("must not be reached");
          },
        });
        expect(outcome).toBe("nothing-to-retry");
      }
    });

    /** Entries on the live queue for this job — `created`, `retry` or `active`. */
    async function liveEntries(jobId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pgboss.job
         WHERE name = ${QUEUES.name}
           AND data->'job'->>'id' = ${jobId}
           AND state < 'completed'
      `;
      return rows[0]?.count ?? 0;
    }
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

      // The quota is enforced from the assertion alone until the pipeline table it reconciles
      // against exists — an unreadable transcript must never read as an unlimited allowance.
      await bare.recordUsage(ACME, uuid("5", 1), { audioBytes: 42, recordedSeconds: 300 });
      expect(await bare.readUsage(ACME, "2026-08-01T00:00:00Z")).toEqual({
        storageBytes: 42,
        monthRecordedSeconds: 300,
      });
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
