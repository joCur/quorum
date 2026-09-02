import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { JobError } from "../errors.js";
import { manifestKey, sessionKey, type KeyScope } from "./keys.js";
import {
  RecordingManifestSchema,
  SessionRecordSchema,
  concatenateChunks,
  resolveChunkKeys,
  type RecordingManifest,
  type SessionRecord,
} from "./manifest.js";

/**
 * Everything the worker needs from object storage. Kept as a port so the job
 * handler can be tested without an S3 endpoint.
 */
export interface AudioSource {
  loadManifest(scope: KeyScope): Promise<RecordingManifest>;
  /** `null` when the session object is gone — the manifest is still enough to work. */
  loadSession(scope: KeyScope): Promise<SessionRecord | null>;
  /**
   * The recording as one byte stream, whichever shape it is stored in.
   *
   * The manifest decides: it names the repackaged file once one exists (ADR-010), and until
   * then the chunk objects are read in manifest order and concatenated. Asking the manifest
   * rather than guessing from a listing is what lets a transcription be run again long after
   * the chunks it originally read were replaced.
   */
  loadAudio(manifest: RecordingManifest, scope: KeyScope): Promise<Uint8Array>;
}

/**
 * The write side of object storage, used by the remux job alone (ADR-010).
 *
 * Separate from `AudioSource` because the asymmetry is the point: everything else in this
 * worker only ever reads the recording. One job may replace it, and it is worth being able to
 * see at a glance which one.
 */
export interface RemuxStorage {
  /** Bytes at a key, or `null` when nothing is stored there. */
  readObject(key: string): Promise<Uint8Array | null>;
  /** Size in bytes of the object at a key, or `null` when nothing is stored there. */
  objectSize(key: string): Promise<number | null>;
  writeObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Server-side copy, so the bytes that were verified are the bytes that get the final name. */
  copyObject(fromKey: string, toKey: string): Promise<void>;
  deleteObjects(keys: readonly string[]): Promise<void>;
  writeManifest(scope: KeyScope, manifest: RecordingManifest): Promise<void>;
}

export interface S3AudioSourceOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** Chunk objects fetched in parallel; keeps long recordings from crawling. */
  concurrency?: number;
  /**
   * Server-side encryption algorithm sent with every write (ADR-001), matching what the
   * recording endpoint sends. The bucket carries default encryption as well, so an object
   * cannot be stored unencrypted even when this is omitted.
   */
  serverSideEncryption?: string;
}

const DEFAULT_CONCURRENCY = 8;

/** S3 `DeleteObjects` accepts at most 1000 keys per request. */
const DELETE_BATCH_SIZE = 1000;

/** S3-compatible reader (MinIO in the compose stack, ADR-006 §5). */
export class S3AudioSource implements AudioSource, RemuxStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly concurrency: number;
  private readonly sse: string | undefined;

  constructor(options: S3AudioSourceOptions, client?: S3Client) {
    const config: S3ClientConfig = {
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    };
    this.client = client ?? new S3Client(config);
    this.bucket = options.bucket;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.sse = options.serverSideEncryption;
  }

  private async getBytes(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = await result.Body?.transformToByteArray();
      return body ? new Uint8Array(body) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new JobError("AUDIO_FETCH_FAILED", `failed to read object "${key}"`, {
        retryable: true,
        cause: error,
      });
    }
  }

  async loadManifest(scope: KeyScope): Promise<RecordingManifest> {
    const bytes = await this.getBytes(manifestKey(scope));
    if (!bytes) {
      throw new JobError(
        "MANIFEST_NOT_FOUND",
        `no manifest for session ${scope.sessionId} — the recording was never finalized`,
        { retryable: false },
      );
    }
    const parsed = RecordingManifestSchema.safeParse(parseJson(bytes, "manifest"));
    if (!parsed.success) {
      throw new JobError("AUDIO_EMPTY", `manifest is malformed: ${parsed.error.message}`, {
        retryable: false,
      });
    }
    return parsed.data;
  }

  async loadSession(scope: KeyScope): Promise<SessionRecord | null> {
    const bytes = await this.getBytes(sessionKey(scope));
    if (!bytes) return null;
    const parsed = SessionRecordSchema.safeParse(parseJson(bytes, "session"));
    return parsed.success ? parsed.data : null;
  }

  async loadAudio(manifest: RecordingManifest, scope: KeyScope): Promise<Uint8Array> {
    // The repackaged file, when the manifest names one. Nothing falls back to the chunks from
    // here: the manifest only names the artifact after it has been verified, and the chunks are
    // deleted immediately afterwards, so a miss here is a real fault and not a shape to guess at.
    if (manifest.audioKey !== null) {
      const bytes = await this.getBytes(manifest.audioKey);
      if (!bytes) {
        throw new JobError(
          "AUDIO_FETCH_FAILED",
          `the manifest names "${manifest.audioKey}" but object storage does not have it`,
          { retryable: true },
        );
      }
      return bytes;
    }

    const keys = resolveChunkKeys(manifest, scope);
    const parts = new Array<Uint8Array>(keys.length);

    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, keys.length) }, async () => {
      for (let index = next++; index < keys.length; index = next++) {
        const key = keys[index] as string;
        const bytes = await this.getBytes(key);
        if (!bytes) {
          throw new JobError(
            "AUDIO_FETCH_FAILED",
            `chunk "${key}" is listed in the manifest but missing from object storage`,
            { retryable: false },
          );
        }
        parts[index] = bytes;
      }
    });
    await Promise.all(workers);

    return concatenateChunks(parts);
  }

  // ---- RemuxStorage ----

  async readObject(key: string): Promise<Uint8Array | null> {
    return this.getBytes(key);
  }

  async objectSize(key: string): Promise<number | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return result.ContentLength ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new JobError("AUDIO_FETCH_FAILED", `failed to stat object "${key}"`, {
        retryable: true,
        cause: error,
      });
    }
  }

  async writeObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
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

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        // The source is bucket-qualified and URI-encoded, which is what the S3 API asks for and
        // what a key holding a character like `+` would otherwise get wrong.
        CopySource: `${this.bucket}/${fromKey}`.split("/").map(encodeURIComponent).join("/"),
        Key: toKey,
        ...(this.sse ? { ServerSideEncryption: this.sse as "AES256" } : {}),
      }),
    );
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
      const errors = result.Errors ?? [];
      if (errors.length > 0) {
        const first = errors[0];
        throw new JobError(
          "AUDIO_FETCH_FAILED",
          `failed to delete ${errors.length} object(s), first: ${first?.Key ?? "?"} (${first?.Code ?? "unknown"})`,
          { retryable: true },
        );
      }
    }
  }

  async writeManifest(scope: KeyScope, manifest: RecordingManifest): Promise<void> {
    await this.writeObject(
      manifestKey(scope),
      new TextEncoder().encode(JSON.stringify(manifest)),
      "application/json",
    );
  }
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new JobError("AUDIO_EMPTY", `${what} object is not valid JSON`, {
      retryable: false,
      cause: error,
    });
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}
