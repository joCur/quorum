import { JobError, MeetingGoneError, toJobError } from "../errors.js";
import { logMeetingGone, type WorkerLogger } from "../logger.js";
import type { AudioSource, RemuxStorage } from "../storage/audio-source.js";
import { audioKey, stagingAudioKey, type KeyScope } from "../storage/keys.js";
import { resolveChunkKeys, type RecordingManifest } from "../storage/manifest.js";
import type { RemuxJobPayload } from "../payload.js";
import { inspectWebm, remuxWebm, RemuxError } from "./webm.js";

/**
 * How far the remuxer's own duration may sit from the transcription's before the result is
 * thrown away.
 *
 * Loose on purpose. The two numbers are measured in different ways — one counts container
 * timestamps, the other counts decoded samples after a voice-activity filter has had its say —
 * so they are never expected to agree to the sample. What this catches is the failure that
 * matters: a parse that lost or duplicated whole stretches of a recording, which shows up as a
 * duration that is wrong by a lot, not by a rounding error.
 */
const DURATION_TOLERANCE_RATIO = 0.05;
const DURATION_TOLERANCE_SECONDS = 10;

/** The only container this pipeline repackages; see the note in `runRemuxJob`. */
const REMUXABLE_CONTAINER = "webm";

/** The part of the meeting index this job reads: only whether the meeting is still there. */
export interface RemuxMeetingCheck {
  meetingExists(meetingId: string, tenantId: string): Promise<boolean>;
}

export interface RemuxHandlerDependencies {
  audio: AudioSource;
  storage: RemuxStorage;
  repository: RemuxMeetingCheck;
  logger: WorkerLogger;
}

export interface RemuxOutcome {
  /** Set when the recording was left exactly as it was, and why. */
  skipped?: "already-remuxed" | "unsupported-container";
  /**
   * Set when the meeting was deleted while the job was running. Nothing was written, and the
   * staged artifact was removed again. Named the way the other handlers name it, because the
   * queue reads this field to keep a deletion out of the success counters.
   */
  abandoned?: "meeting-deleted";
  /** Bytes before and after, so the storage claim of ADR-010 is observable in the logs. */
  sourceBytes?: number;
  remuxedBytes?: number;
  durationSeconds?: number;
  /** Chunk objects removed once the artifact was in place. */
  chunksDeleted?: number;
}

/**
 * Runs one `remux` job: chunk objects → one seekable file → the chunk objects deleted (ADR-010).
 *
 * THE ORDER IS THE WHOLE DESIGN. The artifact is written under a staging name, read back and
 * checked, and only then given the name that playback serves. The manifest is pointed at it
 * next, and the chunk objects go last. Every prefix of that sequence leaves a recording that
 * plays exactly as it did before the job ran — a crash cannot produce a gap, only a leftover
 * staging object that the next attempt overwrites and the deletion cascade removes.
 *
 * IT WRITES NO JOB ROW. The other two handlers do, because a person is waiting for a transcript
 * or a summary and is owed the news when one fails. Nobody asked for this and nobody is waiting:
 * a recording that has not been repackaged plays the way it always did, so the failure is an
 * operator's business — a log line and a dead letter — and not an error card on a meeting.
 */
export async function runRemuxJob(
  payload: RemuxJobPayload,
  attempt: number,
  deps: RemuxHandlerDependencies,
): Promise<RemuxOutcome> {
  const scope: KeyScope = {
    tenantId: payload.tenantId,
    userId: payload.userId,
    sessionId: payload.sessionId,
  };
  const log = deps.logger.child({
    jobId: payload.job.id,
    meetingId: payload.job.meetingId,
    sessionId: payload.sessionId,
    tenantId: payload.tenantId,
    userId: payload.userId,
    attempt,
  });

  try {
    const manifest = await deps.audio.loadManifest(scope);

    if (manifest.audioKey !== null) {
      // A transcription that ran a second time — a user's retry, an operator's redrive — hands
      // this job on again. There is nothing left to do, and saying so costs one read.
      log.info(
        { event: "remux.skipped", reason: "already-remuxed", audioKey: manifest.audioKey },
        "recording is already a single seekable file",
      );
      return { skipped: "already-remuxed" };
    }

    // Only WebM. Ogg carries its own seek information in the Opus granule positions, and the
    // fragmented MP4 a Safari recorder produces is a different container with a different index
    // — neither is what this remuxer reads, and guessing at one would be worse than leaving a
    // recording in the shape it already plays in.
    if (manifest.audioFormat.container.toLowerCase() !== REMUXABLE_CONTAINER) {
      log.info(
        { event: "remux.skipped", reason: "unsupported-container", ...containerOf(manifest) },
        "recording is not in a container this pipeline repackages",
      );
      return { skipped: "unsupported-container" };
    }

    const source = await deps.audio.loadAudio(manifest, scope);
    const remuxed = remux(source);
    checkDuration(remuxed.durationSeconds, payload.expectedDurationSeconds);

    const staging = stagingAudioKey(scope);
    const final = audioKey(scope);
    await deps.storage.writeObject(staging, remuxed.bytes, "audio/webm");
    await verify(deps, staging, remuxed.bytes.byteLength, remuxed.durationSeconds);

    // Last look before anything is replaced. The deletion cascade sweeps the queue, but a job
    // already running survives that sweep, and finishing this one would put audio back under a
    // prefix a user asked to be emptied.
    if (!(await deps.repository.meetingExists(payload.job.meetingId, payload.tenantId))) {
      await deps.storage.deleteObjects([staging]);
      throw new MeetingGoneError(payload.job.meetingId);
    }

    await deps.storage.copyObject(staging, final);
    await deps.storage.writeManifest(scope, {
      ...manifest,
      audioKey: final,
      durationSeconds: remuxed.durationSeconds,
    });

    const chunkKeys = resolveChunkKeys(manifest, scope);
    await deps.storage.deleteObjects([...chunkKeys, staging]);

    log.info(
      {
        event: "remux.completed",
        sourceBytes: source.byteLength,
        remuxedBytes: remuxed.bytes.byteLength,
        durationSeconds: remuxed.durationSeconds,
        clusterCount: remuxed.clusterCount,
        cueCount: remuxed.cueCount,
        chunksDeleted: chunkKeys.length,
      },
      "recording repackaged as one seekable file and the chunk objects removed",
    );

    return {
      sourceBytes: source.byteLength,
      remuxedBytes: remuxed.bytes.byteLength,
      durationSeconds: remuxed.durationSeconds,
      chunksDeleted: chunkKeys.length,
    };
  } catch (error) {
    if (error instanceof MeetingGoneError) {
      logMeetingGone(log, "remux");
      return { abandoned: "meeting-deleted" };
    }
    const jobError = toJobError(error);
    log.error(
      { event: "remux.failed", code: jobError.code, retryable: jobError.retryable, err: jobError },
      "recording could not be repackaged; it keeps playing from its chunk objects",
    );
    throw jobError;
  }
}

function containerOf(manifest: RecordingManifest): { container: string; codec: string } {
  return { container: manifest.audioFormat.container, codec: manifest.audioFormat.codec };
}

function remux(source: Uint8Array): ReturnType<typeof remuxWebm> {
  try {
    return remuxWebm(source);
  } catch (error) {
    if (error instanceof RemuxError) {
      throw new JobError("REMUX_FAILED", error.message, { retryable: false });
    }
    throw error;
  }
}

function checkDuration(measured: number, expected: number | null): void {
  if (expected === null || expected === 0) return;
  const tolerance = Math.max(expected * DURATION_TOLERANCE_RATIO, DURATION_TOLERANCE_SECONDS);
  if (Math.abs(measured - expected) <= tolerance) return;
  throw new JobError(
    "REMUX_VERIFICATION_FAILED",
    `repackaged recording is ${measured.toFixed(3)}s long but the transcription measured ${expected.toFixed(3)}s`,
    { retryable: false },
  );
}

/**
 * Reads the staged artifact back out of object storage and checks it is what was written.
 *
 * A read rather than a comparison against what is still in memory, because what is in memory is
 * not what playback will serve. This is the step that stands between a truncated upload and a
 * deleted set of chunks, so it asks storage the same question a player will: how long is it, and
 * does it parse as a seekable file.
 */
async function verify(
  deps: RemuxHandlerDependencies,
  key: string,
  expectedBytes: number,
  expectedDuration: number,
): Promise<void> {
  const stored = await deps.storage.readObject(key);
  if (!stored) {
    throw new JobError("REMUX_VERIFICATION_FAILED", `staged artifact "${key}" is not readable`, {
      retryable: true,
    });
  }
  if (stored.byteLength !== expectedBytes) {
    throw new JobError(
      "REMUX_VERIFICATION_FAILED",
      `staged artifact is ${stored.byteLength} bytes but ${expectedBytes} were written`,
      { retryable: true },
    );
  }
  const inspected = inspectWebm(stored);
  if (!inspected.hasCues || inspected.durationSeconds === null) {
    throw new JobError(
      "REMUX_VERIFICATION_FAILED",
      `staged artifact is missing ${inspected.hasCues ? "a duration" : "its cue index"}`,
      { retryable: false },
    );
  }
  if (Math.abs(inspected.durationSeconds - expectedDuration) > 0.001) {
    throw new JobError(
      "REMUX_VERIFICATION_FAILED",
      `staged artifact reads back as ${inspected.durationSeconds}s rather than ${expectedDuration}s`,
      { retryable: false },
    );
  }
}
