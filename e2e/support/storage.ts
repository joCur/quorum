import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
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
  /** Playing time of the repackaged file, in seconds. */
  durationSeconds: number | null;
  /** Wall-clock pause and resume marks — where the audio-time gaps in the recording are. */
  marks: Array<{ type: "pause" | "resume"; at: string }>;
  finalizedAt: string;
}

export function readManifest(scope: SessionScope): Promise<RecordingManifest | null> {
  return readJson<RecordingManifest>(`${sessionPrefix(scope)}/manifest.json`);
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
