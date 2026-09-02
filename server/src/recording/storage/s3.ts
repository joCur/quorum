import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  chunkKey,
  chunkPrefix,
  manifestKey,
  sessionKey,
  sessionPrefix,
  seqFromChunkKey,
  type KeyScope,
} from "../keys.js";
import type {
  ByteRange,
  RecordingManifest,
  RecordingStorage,
  SessionRecord,
  StoredObject,
} from "../types.js";

/** S3 `DeleteObjects` accepts at most 1000 keys per request. */
const DELETE_BATCH_SIZE = 1000;

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Server-side encryption algorithm sent with every write (ADR-001). The bucket
   * additionally carries default SSE (see `scripts/minio-init.sh`), so an object
   * cannot be stored unencrypted even if this is omitted.
   */
  serverSideEncryption?: string;
  forcePathStyle?: boolean;
}

/**
 * S3-compatible storage adapter (MinIO in the compose stack, ADR-006 §5).
 *
 * One object per chunk rather than a multipart upload: a chunk key is a pure
 * function of the sequence number, which makes re-sends after a reconnect
 * idempotent overwrites and lets the server rebuild `persistedSeq` from a plain
 * prefix listing after a crash. Concatenation into a single audio object is the
 * transcription worker's job, driven by the manifest written on `session.end`.
 */
export class S3RecordingStorage implements RecordingStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly sse: string | undefined;

  constructor(options: S3StorageOptions, client?: S3Client) {
    const config: S3ClientConfig = {
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    };
    this.client = client ?? new S3Client(config);
    this.bucket = options.bucket;
    this.sse = options.serverSideEncryption;
  }

  private async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.sse ? { ServerSideEncryption: this.sse as "AES256" } : {}),
      }),
    );
  }

  async putSession(record: SessionRecord): Promise<void> {
    await this.put(sessionKey(record), encodeJson(record), "application/json");
  }

  async getSession(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: sessionKey({ tenantId, userId, sessionId }),
        }),
      );
      const body = await result.Body?.transformToString();
      return body ? (JSON.parse(body) as SessionRecord) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async putChunk(record: SessionRecord, seq: number, payload: Uint8Array): Promise<void> {
    await this.put(chunkKey(record, seq), payload, "application/octet-stream");
  }

  async listChunkSeqs(record: SessionRecord): Promise<number[]> {
    const prefix = chunkPrefix(record);
    const seqs: number[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        const seq = object.Key ? seqFromChunkKey(object.Key) : null;
        if (seq !== null) seqs.push(seq);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return seqs.sort((a, b) => a - b);
  }

  async putManifest(record: SessionRecord, manifest: RecordingManifest): Promise<void> {
    await this.put(manifestKey(record), encodeJson(manifest), "application/json");
  }

  async getManifest(scope: KeyScope): Promise<RecordingManifest | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: manifestKey(scope) }),
      );
      const body = await result.Body?.transformToString();
      return body ? (JSON.parse(body) as RecordingManifest) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listSessionObjects(scope: KeyScope): Promise<StoredObject[]> {
    // The trailing slash matters: without it the prefix of session "abc" would also match
    // session "abcdef", and a deletion would reach into a recording it was never asked about.
    const prefix = `${sessionPrefix(scope)}/`;
    const objects: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined) continue;
        objects.push({ key: object.Key, size: object.Size ?? 0 });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async readObject(key: string, range?: ByteRange): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.from}-${range.to}` } : {}),
      }),
    );
    const body = await result.Body?.transformToByteArray();
    return body ? new Uint8Array(body) : new Uint8Array(0);
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
      const batch = keys.slice(index, index + DELETE_BATCH_SIZE);
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      // ADR-001 promises that nothing is left behind, so a partial failure has to be loud:
      // the caller keeps the database rows and the deletion stays retryable.
      const errors = result.Errors ?? [];
      if (errors.length > 0) {
        const first = errors[0];
        throw new Error(
          `failed to delete ${errors.length} object(s) from storage, first: ${first?.Key ?? "?"} (${first?.Code ?? "unknown"})`,
        );
      }
    }
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}
