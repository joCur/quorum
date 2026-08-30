import { describe, expect, it } from "vitest";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PgBoss } from "pg-boss";
import { S3RecordingStorage } from "../src/recording/storage/s3.js";
import { PgBossJobQueue, TRANSCRIBE_QUEUE } from "../src/recording/queue/pg-boss.js";
import { chunkKey } from "../src/recording/keys.js";
import { RecordingSessionHandler } from "../src/recording/session.js";
import { FakeConnection, chunk, idSequence } from "./helpers.js";
import { audioLayout } from "../src/meetings/audio.js";
import type { SessionRecord } from "../src/recording/types.js";

/**
 * Integration tests against the real infrastructure from `docker-compose.yml`.
 *
 * They are opt-in because CI has no MinIO/Postgres yet: start the services and
 * run them with
 *
 *   QUORUM_INTEGRATION=1 pnpm vitest run server/test/integration.test.ts
 */
const enabled = process.env.QUORUM_INTEGRATION === "1";

const s3Options = {
  endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  bucket: process.env.S3_BUCKET ?? "recordings",
  accessKeyId: process.env.S3_ACCESS_KEY ?? "quorum-admin",
  secretAccessKey: process.env.S3_SECRET_KEY ?? "CHANGE_ME",
  serverSideEncryption: process.env.S3_SSE ?? "AES256",
};

describe.skipIf(!enabled)("MinIO storage", () => {
  it("persists chunks encrypted at rest under the tenant-scoped key", async () => {
    const storage = new S3RecordingStorage(s3Options);
    const connection = new FakeConnection();
    const tenantId = `tenant-${Date.now()}`;
    const handler = new RecordingSessionHandler(connection, {
      storage,
      queue: { async enqueueTranscribe() {}, async enqueueSummarize() {} },
      context: { tenantId, userId: "user-1" },
      newId: idSequence("a"),
    });

    await handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: "Integration run",
        audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    const sessionId = connection.last("session.ready")?.sessionId as string;
    expect(sessionId).toBeDefined();

    await handler.handleBinary(chunk(sessionId, 0));
    await handler.handleBinary(chunk(sessionId, 1));
    expect(connection.last("chunk.ack")?.persistedSeq).toBe(1);

    const record = await storage.getSession(tenantId, "user-1", sessionId);
    expect(record).not.toBeNull();

    const client = new S3Client({
      endpoint: s3Options.endpoint,
      region: s3Options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: s3Options.accessKeyId,
        secretAccessKey: s3Options.secretAccessKey,
      },
    });
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: s3Options.bucket,
        Key: chunkKey(record as SessionRecord, 1),
      }),
    );
    // The bucket carries default SSE (scripts/minio-init.sh), so MinIO reports
    // the encryption algorithm back on every object.
    expect(head.ServerSideEncryption).toBeDefined();
  });

  it("plays a byte range back and leaves nothing behind when the session is deleted", async () => {
    const storage = new S3RecordingStorage(s3Options);
    const connection = new FakeConnection();
    const tenantId = `tenant-${Date.now()}-delete`;
    const handler = new RecordingSessionHandler(connection, {
      storage,
      queue: { async enqueueTranscribe() {}, async enqueueSummarize() {} },
      context: { tenantId, userId: "user-1" },
      newId: idSequence("c"),
    });

    await handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: "Deletion run",
        audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    const sessionId = connection.last("session.ready")?.sessionId as string;
    await handler.handleBinary(chunk(sessionId, 0));
    await handler.handleBinary(chunk(sessionId, 1));
    await handler.handleText(JSON.stringify({ type: "session.end", sessionId, lastSeq: 1 }));

    const scope = { tenantId, userId: "user-1", sessionId };
    const objects = await storage.listSessionObjects(scope);
    // Chunks plus session.json plus manifest.json.
    expect(objects.length).toBe(4);

    const layout = audioLayout(objects);
    expect(layout.totalBytes).toBeGreaterThan(0);
    const whole = await storage.readObject(layout.parts[0]?.key as string);
    const slice = await storage.readObject(layout.parts[0]?.key as string, { from: 1, to: 2 });
    expect(Array.from(slice)).toEqual(Array.from(whole.slice(1, 3)));

    await storage.deleteObjects(objects.map((object) => object.key));
    // ADR-001: after the cascade, the prefix is empty — chunks, session and manifest alike.
    expect(await storage.listSessionObjects(scope)).toEqual([]);
    // Deleting again must not fail; the cascade has to stay retryable after a partial run.
    await storage.deleteObjects(objects.map((object) => object.key));
  });
});

describe.skipIf(!enabled)("pg-boss queue", () => {
  it("enqueues a transcribe job that the worker can fetch", async () => {
    const connectionString =
      process.env.DATABASE_URL ?? "postgres://quorum:CHANGE_ME@127.0.0.1:5432/quorum";
    const boss = new PgBoss({ connectionString });
    const queue = new PgBossJobQueue(boss);
    await queue.start();

    const jobId = crypto.randomUUID();
    await queue.enqueueTranscribe({
      jobId,
      meetingId: crypto.randomUUID(),
      tenantId: "tenant-a",
      userId: "user-1",
      sessionId: crypto.randomUUID(),
    });

    const [job] = (await boss.fetch(TRANSCRIBE_QUEUE)) ?? [];
    expect(job).toBeDefined();
    await queue.stop();
  });
});
