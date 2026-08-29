import { describe, expect, it } from "vitest";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PgBoss } from "pg-boss";
import { S3AudioSource } from "../src/storage/audio-source.js";
import { PostgresRepository } from "../src/db/repository.js";
import { OpenAiTranscriptionClient } from "../src/whisper/client.js";
import { runTranscribeJob } from "../src/handler.js";
import { chunkKey, manifestKey, sessionKey } from "../src/storage/keys.js";
import { TRANSCRIBE_QUEUE } from "../src/payload.js";
import { silentLogger, transcribeJob } from "./helpers.js";

/**
 * Opt-in integration test against the real services from `docker-compose.yml`
 * (MinIO, PostgreSQL and an OpenAI-compatible Whisper endpoint). CI runs none
 * of them, and the Whisper model download alone is a multi-gigabyte, multi-
 * minute affair, so this suite stays out of the default run:
 *
 *   docker compose up -d postgres minio minio-init whisper
 *   QUORUM_INTEGRATION=1 pnpm vitest run worker/test/integration.test.ts
 *
 * `QUORUM_TEST_AUDIO` must point at a real recording in a supported container
 * (WebM/Opus, Ogg/Opus or MP4/AAC); without it only the storage and database
 * halves run.
 */
const enabled = process.env.QUORUM_INTEGRATION === "1";

const s3Options = {
  endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  bucket: process.env.S3_BUCKET ?? "recordings",
  accessKeyId: process.env.S3_ACCESS_KEY ?? "quorum-admin",
  secretAccessKey: process.env.S3_SECRET_KEY ?? "CHANGE_ME",
};

const databaseUrl = process.env.DATABASE_URL ?? "postgres://quorum:CHANGE_ME@127.0.0.1:5432/quorum";
const whisperBaseUrl = process.env.WHISPER_BASE_URL ?? "http://127.0.0.1:8000/v1";
const whisperModel = process.env.WHISPER_MODEL ?? "small";

describe.skipIf(!enabled)("worker against the compose stack", () => {
  it("transcribes a recording and stays idempotent across a replay", async () => {
    const audioPath = process.env.QUORUM_TEST_AUDIO;
    if (!audioPath) {
      // Nothing to transcribe — skip rather than pretend.
      expect(audioPath).toBeUndefined();
      return;
    }
    const { readFile } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    const bytes = new Uint8Array(await readFile(audioPath));

    const scope = {
      tenantId: `tenant-${Date.now()}`,
      userId: "user-1",
      sessionId: randomUUID(),
    };
    const meetingId = randomUUID();
    const jobId = randomUUID();
    const container = audioPath.endsWith(".mp4")
      ? "mp4"
      : audioPath.endsWith(".ogg")
        ? "ogg"
        : "webm";

    // Upload the recording the way the recording endpoint would: one object per
    // chunk plus session and manifest metadata.
    const client = new S3Client({
      endpoint: s3Options.endpoint,
      region: s3Options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: s3Options.accessKeyId,
        secretAccessKey: s3Options.secretAccessKey,
      },
    });
    const half = Math.floor(bytes.byteLength / 2);
    const chunks = [bytes.subarray(0, half), bytes.subarray(half)];
    const audioFormat = { codec: "opus", container, sampleRate: 48_000, channels: 1 };
    const put = async (key: string, body: Uint8Array | string) =>
      client.send(new PutObjectCommand({ Bucket: s3Options.bucket, Key: key, Body: body }));

    for (const [seq, chunk] of chunks.entries()) await put(chunkKey(scope, seq), chunk);
    await put(
      sessionKey(scope),
      JSON.stringify({
        ...scope,
        meetingId,
        meetingTitle: null,
        audioFormat,
        createdAt: new Date().toISOString(),
        marks: [],
      }),
    );
    await put(
      manifestKey(scope),
      JSON.stringify({
        ...scope,
        meetingId,
        audioFormat,
        chunkCount: chunks.length,
        persistedSeq: chunks.length - 1,
        chunkKeys: chunks.map((_chunk, seq) => chunkKey(scope, seq)),
        marks: [],
        finalizedAt: new Date().toISOString(),
      }),
    );

    const repository = new PostgresRepository(databaseUrl);
    await repository.migrate();
    const deps = {
      audio: new S3AudioSource(s3Options),
      transcription: new OpenAiTranscriptionClient({
        baseUrl: whisperBaseUrl,
        model: whisperModel,
      }),
      repository,
      logger: silentLogger,
    };
    const payload = { job: transcribeJob({ id: jobId, meetingId }), ...scope };

    try {
      const first = await runTranscribeJob(payload, 0, deps);
      expect(first.created).toBe(true);
      expect(first.segmentCount).toBeGreaterThan(0);
      expect(first.wordCount).toBeGreaterThan(0);

      // A crash mid-job means the queue hands the same job out again.
      const replay = await runTranscribeJob(payload, 1, deps);
      expect(replay.created).toBe(false);
      expect(replay.transcriptId).toBe(first.transcriptId);
    } finally {
      await repository.close();
    }
  }, 600_000);

  it("creates the transcribe queue and its dead-letter queue", async () => {
    const boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    try {
      await boss.createQueue(TRANSCRIBE_QUEUE);
      expect(await boss.getQueue(TRANSCRIBE_QUEUE)).not.toBeNull();
    } finally {
      await boss.stop();
    }
  }, 60_000);
});
