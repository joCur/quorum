import type { Job, Transcript } from "@quorum/shared";
import { pino } from "pino";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AudioSource } from "../src/storage/audio-source.js";
import type { RecordingManifest } from "../src/storage/manifest.js";
import type { JobScope, SaveTranscriptResult, TranscriptRepository } from "../src/db/repository.js";
import type { TranscriptionClient, TranscriptionRequest } from "../src/whisper/client.js";
import type { WhisperTranscriptionResponse } from "../src/whisper/response.js";
import type { TranscribeJobPayload } from "../src/payload.js";
import { chunkKey } from "../src/storage/keys.js";
import { MeetingGoneError } from "../src/errors.js";
import type { WorkerLogger } from "../src/logger.js";

export const SCOPE: JobScope = {
  tenantId: "tenant-a",
  userId: "user-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
};

export const JOB_ID = "22222222-2222-4222-8222-222222222222";
export const MEETING_ID = "33333333-3333-4333-8333-333333333333";

/** Silent logger — most tests assert on behavior, not on log output. */
export const silentLogger = pino({ level: "silent" });

/**
 * Logger that keeps every line it emits, for the few assertions where the log
 * *is* the observable outcome — an abandoned job writes nothing else.
 */
export function capturingLogger(): {
  logger: WorkerLogger;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  const logger = pino(
    // Same level formatting as `createLogger`, so assertions see the labels
    // that actually reach the log.
    { level: "info", base: null, formatters: { level: (label: string) => ({ level: label }) } },
    {
      write(line: string) {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, events };
}

export function transcribeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    meetingId: MEETING_ID,
    type: "transcribe",
    status: "queued",
    progress: null,
    error: null,
    resultId: null,
    createdAt: "2026-08-29T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

export function transcribePayload(
  overrides: Partial<TranscribeJobPayload> = {},
): TranscribeJobPayload {
  return { job: transcribeJob(), ...SCOPE, ...overrides };
}

export function manifest(overrides: Partial<RecordingManifest> = {}): RecordingManifest {
  const chunkCount = overrides.chunkCount ?? 3;
  return {
    sessionId: SCOPE.sessionId,
    meetingId: MEETING_ID,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    chunkCount,
    persistedSeq: chunkCount - 1,
    chunkKeys: Array.from({ length: chunkCount }, (_value, seq) => chunkKey(SCOPE, seq)),
    marks: [],
    finalizedAt: "2026-08-29T10:30:00.000Z",
    ...overrides,
  };
}

/** A realistic `verbose_json` body with segment-level `words[]`, as speaches returns it. */
export const VERBOSE_RESPONSE_WITH_WORDS: WhisperTranscriptionResponse = {
  task: "transcribe",
  language: "en",
  duration: 4.2,
  text: " Good morning everyone. Let us start.",
  segments: [
    {
      id: 0,
      start: 0,
      end: 2.1,
      text: " Good morning everyone.",
      avg_logprob: -0.223_143_551_314_21,
      no_speech_prob: 0.01,
      words: [
        { word: "Good", start: 0.12, end: 0.44 },
        { word: "morning", start: 0.44, end: 0.9 },
        { word: "everyone.", start: 0.9, end: 1.6 },
      ],
    },
    {
      id: 1,
      start: 2.1,
      end: 4.2,
      text: " Let us start.",
      avg_logprob: -0.5,
      words: [
        { word: "Let", start: 2.2, end: 2.5 },
        { word: "us", start: 2.5, end: 2.7 },
        { word: "start.", start: 2.7, end: 3.4 },
      ],
    },
  ],
};

/** The OpenAI shape: a flat `words[]` and segments without words of their own. */
export const VERBOSE_RESPONSE_FLAT_WORDS: WhisperTranscriptionResponse = {
  task: "transcribe",
  language: "de",
  duration: 4.2,
  text: " Guten Morgen zusammen. Wir fangen an.",
  segments: [
    { start: 0, end: 2.1, text: " Guten Morgen zusammen." },
    { start: 2.1, end: 4.2, text: " Wir fangen an." },
  ],
  words: [
    { word: "Guten", start: 0.12, end: 0.44 },
    { word: "Morgen", start: 0.44, end: 0.9 },
    { word: "zusammen.", start: 0.9, end: 1.6 },
    { word: "Wir", start: 2.2, end: 2.5 },
    { word: "fangen", start: 2.5, end: 2.7 },
    { word: "an.", start: 2.7, end: 3.4 },
  ],
};

export class FakeAudioSource implements AudioSource {
  loadManifestCalls = 0;
  loadAudioCalls = 0;

  constructor(
    private readonly value: RecordingManifest = manifest(),
    private readonly audio: Uint8Array = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
    private readonly sessionCreatedAt: string | null = "2026-08-29T10:00:00.000Z",
  ) {}

  async loadManifest(): Promise<RecordingManifest> {
    this.loadManifestCalls += 1;
    return this.value;
  }

  async loadSession() {
    if (this.sessionCreatedAt === null) return null;
    return {
      sessionId: SCOPE.sessionId,
      meetingId: MEETING_ID,
      tenantId: SCOPE.tenantId,
      userId: SCOPE.userId,
      meetingTitle: null,
      audioFormat: this.value.audioFormat,
      createdAt: this.sessionCreatedAt,
      marks: [],
    };
  }

  async loadAudio(): Promise<Uint8Array> {
    this.loadAudioCalls += 1;
    return this.audio;
  }
}

export class FakeTranscriptionClient implements TranscriptionClient {
  readonly requests: TranscriptionRequest[] = [];

  constructor(
    readonly model = "small",
    private readonly response: WhisperTranscriptionResponse = VERBOSE_RESPONSE_WITH_WORDS,
    private readonly failure?: Error,
  ) {}

  async transcribe(request: TranscriptionRequest): Promise<WhisperTranscriptionResponse> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return this.response;
  }
}

/**
 * In-memory stand-in for the PostgreSQL repository. It reproduces the three
 * rules the real implementation relies on: `job_id` is unique, only one
 * transcript per meeting is active, and a transcript is only ever written for a
 * meeting that still exists.
 */
export class InMemoryRepository implements TranscriptRepository {
  readonly transcripts = new Map<string, { transcript: Transcript; scope: JobScope }>();
  readonly byJob = new Map<string, string>();
  readonly jobStates: Job[] = [];
  readonly meetings = new Set<string>([MEETING_ID]);
  /**
   * Runs at the top of `saveTranscript`, standing in for a delete that commits
   * in the last instant before the write.
   */
  onBeforeSaveTranscript: (() => void) | null = null;
  migrated = false;

  async migrate(): Promise<void> {
    this.migrated = true;
  }

  async saveTranscript(
    transcript: Transcript,
    scope: JobScope,
    jobId: string,
  ): Promise<SaveTranscriptResult> {
    this.onBeforeSaveTranscript?.();
    // The real repository checks and inserts in one transaction; here the
    // single-threaded fake gives the same guarantee for free.
    if (!this.meetings.has(transcript.meetingId)) {
      throw new MeetingGoneError(transcript.meetingId);
    }
    const existing = this.byJob.get(jobId);
    if (existing) return { transcriptId: existing, created: false };
    for (const entry of this.transcripts.values()) {
      if (entry.transcript.meetingId === transcript.meetingId) {
        entry.transcript = { ...entry.transcript, isActive: false };
      }
    }
    this.transcripts.set(transcript.id, { transcript, scope });
    this.byJob.set(jobId, transcript.id);
    return { transcriptId: transcript.id, created: true };
  }

  async saveJob(job: Job): Promise<void> {
    // Mirrors the real repository: no job row is recorded for a meeting that is
    // no longer there.
    if (!this.meetings.has(job.meetingId)) return;
    this.jobStates.push(job);
  }

  async close(): Promise<void> {}

  get activeTranscripts(): Transcript[] {
    return [...this.transcripts.values()]
      .map((entry) => entry.transcript)
      .filter((transcript) => transcript.isActive);
  }
}

/** Minimal S3 client double: resolves object keys out of a map. */
export function fakeS3Client(objects: Map<string, Uint8Array>): S3Client {
  return {
    async send(command: { input: { Key?: string } }) {
      const key = command.input.Key ?? "";
      const bytes = objects.get(key);
      if (!bytes) {
        const error = new Error(`no such key: ${key}`);
        error.name = "NoSuchKey";
        throw error;
      }
      return { Body: { transformToByteArray: async () => bytes } };
    },
  } as unknown as S3Client;
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
