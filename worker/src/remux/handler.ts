import { JobError, MeetingGoneError, toJobError } from "../errors.js";
import { logMeetingGone, type WorkerLogger } from "../logger.js";
import type { AudioSource, RemuxStorage } from "../storage/audio-source.js";
import { audioKey, sessionPrefix, stagingAudioKey, type KeyScope } from "../storage/keys.js";
import { resolveChunkKeys, type RecordingManifest } from "../storage/manifest.js";
import type { RemuxJobPayload } from "../payload.js";
import { inspectWebm, remuxWebm, RemuxError, scanClusterMarks } from "./webm.js";

/**
 * How far the remuxer's duration may sit from the transcription's before it is worth a log line.
 *
 * A note, never a refusal, and the transcription backend is the reason. It reports the length of
 * what it decoded, and with the silence filter on (`WHISPER_VAD_FILTER`) that is the length of
 * the *speech* — a recording of a room that waits a minute for someone to talk is honestly
 * shorter to Whisper than it is to the container. Failing on the gap would throw away a perfectly
 * good repackaging of exactly the recordings the filter exists for. What the artifact is actually
 * held to is the read-back check below, which needs no second opinion from anyone.
 */
const DURATION_NOTE_RATIO = 0.25;
const DURATION_NOTE_SECONDS = 30;

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
  /** Names this run's staging object; injected so the tests can stage a collision on purpose. */
  newRunId: () => string;
}

export interface RemuxOutcome {
  /** Set when the recording was left exactly as it was, and why. */
  skipped?: "already-remuxed" | "unsupported-container" | "lost-race";
  /**
   * Set when the meeting was deleted while the job was running. Nothing was written, and the
   * staged artifact was removed again. Named the way the other handlers name it, because the
   * queue reads this field to keep a deletion out of the success counters.
   */
  abandoned?: "meeting-deleted";
  sourceBytes?: number;
  remuxedBytes?: number;
  durationSeconds?: number;
  chunksDeleted?: number;
}

/**
 * Runs one `remux` job (ADR-010).
 *
 * THE ORDER IS THE WHOLE DESIGN. The artifact is written under a staging name, read back and
 * checked, and only then given the name that playback serves. The manifest is pointed at it
 * next, and the chunk objects go last. Every prefix of that sequence leaves a recording that
 * plays exactly as it did before the job ran — a crash cannot produce a gap, only a staging
 * object, and that is removed on the way out whichever way the run ends.
 *
 * IT ASSUMES IT IS NOT ALONE. The queue does not promise that one recording gets one job (see
 * the enqueuer), so this is written to be correct with a second copy of itself running against
 * the same objects: the staging name is per run, the artifact copy is the commit point and is
 * guarded by a fresh read of the manifest, and a run that finds the work already done — before
 * it starts, at the commit point, or by way of the read that failed because the winner had
 * already deleted the chunks — reports that it changed nothing rather than failing.
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

  // This run's own staging object. Nothing else writes it, reads it or deletes it, which is what
  // keeps a second run of the same repackaging from pulling the file out from under this one.
  const staging = stagingAudioKey(scope, deps.newRunId());

  try {
    const manifest = await deps.audio.loadManifest(scope);

    if (manifest.audioKey !== null) {
      // A run that died between pointing the manifest at the artifact and deleting the chunks
      // leaves the recording stored twice, and nothing else would ever come back for it. The
      // sweep is what makes "the artifact exists, so the chunk prefix is empty" an invariant
      // rather than something that is merely usually true.
      const swept = await sweepLeftovers(deps, scope, log);
      log.info(
        { event: "remux.skipped", reason: "already-remuxed", audioKey: manifest.audioKey, swept },
        swept > 0
          ? "recording is already a single seekable file; removed what an earlier run left behind"
          : "recording is already a single seekable file",
      );
      return { skipped: "already-remuxed", chunksDeleted: swept };
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
    noteDurationGap(log, remuxed.durationSeconds, payload.expectedDurationSeconds);

    const final = audioKey(scope);
    await deps.storage.writeObject(staging, remuxed.bytes, "audio/webm");
    await verify(deps, staging, remuxed);

    // The commit point. The check at the top of this function was made before a slow read of the
    // whole recording; re-reading immediately before the copy narrows the window in which two
    // runs can both believe they are first to a couple of storage calls. Both getting through it
    // is still correct — the remuxer is a pure function of the same bytes, so they would publish
    // identical files — but that is a property to be glad of, not one to rest the design on.
    if (await alreadyRemuxed(deps, scope)) {
      log.info(
        { event: "remux.skipped", reason: "lost-race" },
        "another run repackaged this recording first; this one changed nothing",
      );
      return { skipped: "lost-race" };
    }

    // The deletion cascade sweeps the queue, but a job already running survives that sweep, and
    // finishing this one would put audio back under a prefix a user asked to be emptied.
    if (!(await deps.repository.meetingExists(payload.job.meetingId, payload.tenantId))) {
      throw new MeetingGoneError(payload.job.meetingId);
    }

    await deps.storage.copyObject(staging, final);
    await deps.storage.writeManifest(scope, {
      ...manifest,
      audioKey: final,
      artifactDurationSeconds: remuxed.durationSeconds,
    });

    const chunkKeys = resolveChunkKeys(manifest, scope);
    await deps.storage.deleteObjects(chunkKeys);

    // The check before the copy narrows that window but cannot close it: the cascade lists the
    // session prefix and then deletes what it listed, so one that listed before this job's copy
    // removes an older set of keys and leaves the artifact and its manifest behind under a
    // meeting that no longer exists — audio a user asked to be destroyed, kept forever.
    if (!(await deps.repository.meetingExists(payload.job.meetingId, payload.tenantId))) {
      throw new MeetingGoneError(payload.job.meetingId);
    }

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
      // The whole prefix, not just what this run wrote: if the cascade ran mid-flight, either
      // side may have left the other's keys behind, and ADR-001 promises nothing survives.
      await clearSessionPrefix(deps, scope, log);
      logMeetingGone(log, "remux");
      return { abandoned: "meeting-deleted" };
    }

    // A run that finished first deleted the chunk objects this one was still reading, and the
    // read that then failed says "a chunk the manifest promised is missing" — a genuine fault on
    // its own, and nothing at all when the work is simply already done. Without this, the
    // ordinary case of a transcription running twice dead-letters a healthy recording.
    if (await alreadyRemuxed(deps, scope).catch(() => false)) {
      log.info(
        { event: "remux.skipped", reason: "lost-race", err: error },
        "another run repackaged this recording first; this one changed nothing",
      );
      return { skipped: "lost-race" };
    }

    const jobError = toJobError(error);
    log.error(
      { event: "remux.failed", code: jobError.code, retryable: jobError.retryable, err: jobError },
      "recording could not be repackaged; it keeps playing from its chunk objects",
    );
    throw jobError;
  } finally {
    // A per-run name means nothing else is waiting on this object, so it can go unconditionally.
    await deps.storage.deleteObjects([staging]).catch((error: unknown) => {
      log.warn(
        { event: "remux.staging_cleanup_failed", err: error, key: staging },
        "could not remove the staged copy; the deletion cascade will",
      );
    });
  }
}

/**
 * PRECONDITION: the manifest already names a verified artifact, so the audio is safe before a
 * single key goes. Calling this any earlier would delete a recording that has no replacement.
 */
async function sweepLeftovers(
  deps: RemuxHandlerDependencies,
  scope: KeyScope,
  log: WorkerLogger,
): Promise<number> {
  try {
    const prefix = `${sessionPrefix(scope)}/`;
    const stale = (await deps.storage.listKeys(prefix)).filter(
      (key) => key.startsWith(`${prefix}chunks/`) || key.includes("/audio.webm.staging."),
    );
    if (stale.length === 0) return 0;
    await deps.storage.deleteObjects(stale);
    return stale.length;
  } catch (error) {
    // Tidying is not worth failing a job that had nothing to do in the first place.
    log.warn(
      { event: "remux.sweep_failed", err: error },
      "could not remove what an earlier run left behind",
    );
    return 0;
  }
}

async function clearSessionPrefix(
  deps: RemuxHandlerDependencies,
  scope: KeyScope,
  log: WorkerLogger,
): Promise<void> {
  try {
    const keys = await deps.storage.listKeys(`${sessionPrefix(scope)}/`);
    if (keys.length > 0) await deps.storage.deleteObjects(keys);
  } catch (error) {
    // Loud, because this is the one cleanup whose failure leaves deleted audio in the bucket.
    log.error(
      { event: "remux.cascade_cleanup_failed", err: error, sessionId: scope.sessionId },
      "could not remove the audio of a meeting that was deleted mid-run",
    );
  }
}

/** Read fresh every time: the point of asking is that another run may have just answered it. */
async function alreadyRemuxed(deps: RemuxHandlerDependencies, scope: KeyScope): Promise<boolean> {
  return (await deps.audio.loadManifest(scope)).audioKey !== null;
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

function noteDurationGap(log: WorkerLogger, measured: number, expected: number | null): void {
  if (expected === null || expected === 0) return;
  const tolerance = Math.max(expected * DURATION_NOTE_RATIO, DURATION_NOTE_SECONDS);
  if (Math.abs(measured - expected) <= tolerance) return;
  log.info(
    { event: "remux.duration_differs", containerSeconds: measured, decodedSeconds: expected },
    "the container is a different length from what the transcription decoded",
  );
}

/**
 * A read from storage rather than a comparison against what is still in memory, because what is
 * in memory is not what playback will serve. This is the step that stands between a truncated
 * upload and a deleted set of chunks.
 *
 * The cluster count is the integrity check the whole "verify, then delete" order rests on. A
 * parse that quietly lost half a recording would produce a file of plausible size that still
 * opened cleanly; a count that no longer matches is what makes it impossible to miss.
 */
async function verify(
  deps: RemuxHandlerDependencies,
  key: string,
  remuxed: { bytes: Uint8Array; durationSeconds: number; sourceClusterMarks: number },
): Promise<void> {
  const stored = await deps.storage.readObject(key);
  if (!stored) {
    throw new JobError("REMUX_VERIFICATION_FAILED", `staged artifact "${key}" is not readable`, {
      retryable: true,
    });
  }
  if (stored.byteLength !== remuxed.bytes.byteLength) {
    throw new JobError(
      "REMUX_VERIFICATION_FAILED",
      `staged artifact is ${stored.byteLength} bytes but ${remuxed.bytes.byteLength} were written`,
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
  if (Math.abs(inspected.durationSeconds - remuxed.durationSeconds) > 0.001) {
    throw new JobError(
      "REMUX_VERIFICATION_FAILED",
      `staged artifact reads back as ${inspected.durationSeconds}s rather than ${remuxed.durationSeconds}s`,
      { retryable: false },
    );
  }
  // The independent half of the check. `scanClusterMarks` walks the stored bytes looking for the
  // cluster id and shares no code with the parser that wrote them, so a parser that dropped
  // clusters cannot satisfy it by reporting the smaller number it arrived at. The source and the
  // artifact hold the same cluster contents byte for byte, so an accidental match inside the
  // audio occurs in both and the two counts still have to agree exactly.
  const storedMarks = scanClusterMarks(stored);
  if (storedMarks !== remuxed.sourceClusterMarks) {
    throw new JobError(
      "REMUX_VERIFICATION_FAILED",
      `staged artifact holds ${storedMarks} clusters, not the ${remuxed.sourceClusterMarks} the recording arrived with`,
      { retryable: false },
    );
  }
}
