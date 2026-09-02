import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { expect } from "@playwright/test";
import { stackEnv } from "./env.js";

/**
 * Object-storage assertions.
 *
 * The suite checks what actually landed in MinIO rather than what the UI claims, because the
 * whole point of the chunk protocol is that acknowledged audio is durable. The key layout is the
 * one the recording endpoint and the worker both implement:
 *
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/chunks/<seq:010d>.bin
 *
 * A recording lives in that shape until the pipeline repackages it into one seekable file
 * (ADR-010), after which the chunk prefix is empty and the audio is a single object:
 *
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/audio.webm
 */

export interface SessionScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

const client = new S3Client({
  endpoint: stackEnv.s3.endpoint,
  region: stackEnv.s3.region,
  credentials: {
    accessKeyId: stackEnv.s3.accessKeyId,
    secretAccessKey: stackEnv.s3.secretAccessKey,
  },
  forcePathStyle: true,
});

export function sessionPrefix(scope: SessionScope): string {
  return `tenants/${scope.tenantId}/users/${scope.userId}/sessions/${scope.sessionId}`;
}

export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: stackEnv.s3.bucket,
        Prefix: prefix,
        ...(token === undefined ? {} : { ContinuationToken: token }),
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key !== undefined) keys.push(object.Key);
    }
    token = page.NextContinuationToken;
  } while (token !== undefined);
  return keys.sort();
}

/** The seekable file the chunks are replaced by once the pipeline has been through them. */
export function audioKey(scope: SessionScope): string {
  return `${sessionPrefix(scope)}/audio.webm`;
}

/** Sequence numbers of the chunk objects stored for a session, in ascending order. */
export async function chunkSeqs(scope: SessionScope): Promise<number[]> {
  const keys = await listKeys(`${sessionPrefix(scope)}/chunks/`);
  return keys
    .map((key) => /\/chunks\/(\d+)\.bin$/.exec(key)?.[1])
    .filter((seq): seq is string => seq !== undefined)
    .map((seq) => Number.parseInt(seq, 10))
    .sort((left, right) => left - right);
}

export async function readJson<T>(key: string): Promise<T | null> {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: stackEnv.s3.bucket, Key: key }),
    );
    const body = await response.Body?.transformToString();
    return body === undefined ? null : (JSON.parse(body) as T);
  } catch {
    return null;
  }
}

export interface RecordingManifest {
  sessionId: string;
  meetingId: string;
  tenantId: string;
  userId: string;
  chunkCount: number;
  persistedSeq: number;
  chunkKeys: string[];
  /** The repackaged file, once one exists; `null` while the recording is still its chunks. */
  audioKey: string | null;
  /** Playing time the repackaged file declares, in seconds. */
  artifactDurationSeconds: number | null;
  /** Wall-clock pause and resume marks — where the audio-time gaps in the recording are. */
  marks: Array<{ type: "pause" | "resume"; at: string }>;
  /** Seconds of audio the client asserted, which the pipeline reconciles against the real audio. */
  recordedSeconds: number | null;
  finalizedAt: string;
}

export function readManifest(scope: SessionScope): Promise<RecordingManifest | null> {
  return readJson<RecordingManifest>(`${sessionPrefix(scope)}/manifest.json`);
}

/**
 * Asserts that the recording reached durable storage whole — in whichever of the two shapes it is
 * currently in.
 *
 * A finalized recording is its chunk objects until the pipeline repackages it into one seekable
 * file (ADR-010), and there is no telling from outside which side of that a given assertion lands
 * on: on a fast machine the transcription and the repackaging both finish between the
 * `session.finalized` frame and the next line of a test. Counting chunk objects is therefore not
 * a stable question, and a test that asked it would fail for a reason unrelated to what it tests.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is compare the manifest to itself. `chunkCount` and
 * `persistedSeq` are written from one another by the server, so holding one against the other
 * proves nothing; and in the repackaged shape the manifest is the very thing a bad remux would
 * have rewritten. So the count is taken from the manifest and then checked against something the
 * manifest had no part in producing: the chunk objects themselves while they are there, and
 * afterwards the artifact's own clusters, counted out of the bytes in the bucket.
 *
 * Returns the number of chunks the recording was made of.
 */
export async function expectRecordingIntact(
  scope: SessionScope,
  options: { atLeast?: number } = {},
): Promise<number> {
  const manifest = await readManifest(scope);
  expect(manifest, "the finalization manifest").not.toBeNull();
  const chunkCount = manifest?.chunkCount ?? 0;
  if (options.atLeast !== undefined) expect(chunkCount).toBeGreaterThanOrEqual(options.atLeast);

  const seqs = await chunkSeqs(scope);
  const expected = Array.from({ length: chunkCount }, (_value, index) => index);
  if (seqs.length === chunkCount && seqs.length > 0) {
    // Still the shape it was recorded in: every sequence number the manifest claims, exactly once.
    expect(seqs).toEqual(expected);
    return chunkCount;
  }

  // Either repackaged, or caught mid-sweep with some chunks already gone. Both are answered the
  // same way and by the artifact, not by counting what is left: a partial listing is a moment in
  // a deletion, not a missing recording.
  const artifact = await readObject(audioKey(scope));
  expect(artifact, `the repackaged audio object for session ${scope.sessionId}`).not.toBeNull();
  const bytes = artifact as Uint8Array;
  expect(bytes.byteLength).toBeGreaterThan(0);

  // The independent half. A remux that dropped half the recording would still produce a valid
  // file of plausible size, and the manifest it wrote would agree with it — so the artifact is
  // held to the one number neither it nor the manifest could fake: `MediaRecorder` opens a
  // cluster per delivered blob, so the clusters in the file track the chunks that were sent.
  // Counted with a byte scan here rather than with the worker's parser, on purpose.
  const clusters = countClusters(bytes);
  expect(clusters, "clusters in the repackaged file").toBeGreaterThanOrEqual(chunkCount - 2);
  // And it declares a length, which is the whole point of the exercise.
  expect(hasCueIndex(bytes), "a cue index in the repackaged file").toBe(true);
  return chunkCount;
}

/** Reads a stored object, or `null` when there is nothing at that key. */
export async function readObject(key: string): Promise<Uint8Array | null> {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: stackEnv.s3.bucket, Key: key }),
    );
    const body = await response.Body?.transformToByteArray();
    return body === undefined ? null : new Uint8Array(body);
  } catch {
    return null;
  }
}

/** Size in bytes of a stored object, or `null` when there is nothing at that key. */
export async function objectSize(key: string): Promise<number | null> {
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: stackEnv.s3.bucket, Key: key }),
    );
    return response.ContentLength ?? null;
  } catch {
    return null;
  }
}

/** Matroska cluster ids in a file, found by scanning rather than by parsing. */
function countClusters(bytes: Uint8Array): number {
  return occurrences(bytes, [0x1f, 0x43, 0xb6, 0x75]);
}

/** Whether the file carries a Cues element — what a player seeks by. */
function hasCueIndex(bytes: Uint8Array): boolean {
  return occurrences(bytes, [0x1c, 0x53, 0xbb, 0x6b]) > 0;
}

function occurrences(haystack: Uint8Array, needle: readonly number[]): number {
  let found = 0;
  let at = 0;
  const buffer = Buffer.from(haystack);
  const pattern = Buffer.from(needle);
  for (;;) {
    const next = buffer.indexOf(pattern, at);
    if (next === -1) return found;
    found += 1;
    at = next + pattern.byteLength;
  }
}
