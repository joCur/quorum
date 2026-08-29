import { GetObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
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
  /** Chunks in manifest order, concatenated into the original container stream. */
  loadAudio(manifest: RecordingManifest, scope: KeyScope): Promise<Uint8Array>;
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
}

const DEFAULT_CONCURRENCY = 8;

/** S3-compatible reader (MinIO in the compose stack, ADR-006 §5). */
export class S3AudioSource implements AudioSource {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly concurrency: number;

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
