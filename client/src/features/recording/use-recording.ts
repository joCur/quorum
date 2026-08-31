import * as React from "react";
import type { LimitErrorCode } from "@quorum/shared";
import { webSocketUrl } from "@/env";
import { useAuth } from "@/features/auth/auth-provider";
import {
  describeAudioFormat,
  describeClient,
  selectRecordingFormat,
} from "@/features/recording/audio-format";
import {
  createAudioMixer,
  setCaptureEnabled,
  type AudioMixer,
} from "@/features/recording/audio-mixer";
import type { CaptureMode } from "@/features/recording/capture-mode";
import {
  DisplayCaptureError,
  requestDisplayAudio,
  type DisplayCaptureFailure,
} from "@/features/recording/display-capture";
import {
  openChunkBuffer,
  storageHeadroom,
  type BufferedSession,
  type ChunkBuffer,
} from "@/features/recording/chunk-buffer";
import {
  RecordingClient,
  type RecordingClientError,
  type RecordingClientStatus,
} from "@/features/recording/protocol-client";
import {
  isWakeLockSupported,
  requestWakeLock,
  type WakeLockHandle,
} from "@/features/recording/wake-lock";
import { isRecordingFinalizedDespite } from "@/features/limits/messages";
import { LEVEL_EPSILON, followEnvelope, normalizeRms } from "@/lib/level-envelope";

/** Route the recording endpoint is mounted on server-side. */
export const RECORDING_PATH = "ws/recording";

/** Chunk length in milliseconds — the 1–2 s window ADR-002 asks for. */
export const CHUNK_INTERVAL_MS = 1_000;

/** Level below which the input counts as silence. */
export const SILENCE_LEVEL = 0.02;

/** How long the input may stay near silence before the UI says something. */
export const SILENCE_HINT_SECONDS = 10;

/** Free storage fraction below which the buffer warning escalates. */
export const STORAGE_PRESSURE_THRESHOLD = 0.1;

export type RecordingPhase =
  "idle" | "requesting" | "recording" | "paused" | "finalizing" | "finalized" | "error";

export interface RecordingError {
  /** Distinguishes the cases the UI must explain differently. */
  kind:
    | "permission-denied"
    | "unsupported"
    | "storage"
    | "connection"
    | "input-lost"
    | "unknown"
    /** The share picker was dismissed or refused. */
    | "display-denied"
    /** A share came back without sound — the checkbox, or a platform that has none to give. */
    | "display-no-audio"
    /** This browser has no screen capture at all. */
    | "display-unsupported";
  detail?: string | undefined;
}

/** Maps a display-capture failure onto the error the screen explains. */
function displayErrorKind(reason: DisplayCaptureFailure): RecordingError["kind"] {
  if (reason === "no-audio") return "display-no-audio";
  if (reason === "unsupported") return "display-unsupported";
  return "display-denied";
}

/**
 * Everything one capture owns, so it can be rebuilt in one piece.
 *
 * The microphone can be swapped and the shared audio can be re-picked while a session runs; both
 * mean tearing the audio graph down and building another one. Keeping the parts together is what
 * makes those two operations the same operation.
 */
interface Capture {
  /** What `MediaRecorder` records — the mixed track online, the raw microphone in person. */
  recordStream: MediaStream;
  mic: MediaStream;
  /** The display audio, video already discarded. `null` for an in-person recording. */
  display: MediaStream | null;
  /** Present exactly when there is more than one source to sum. */
  mixer: AudioMixer | null;
}

/** Audio constraints every capture asks for, whichever input it uses. */
function audioConstraints(deviceId: string | null): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId === null ? {} : { deviceId: { exact: deviceId } }),
  };
}

/**
 * Assembles a capture from the sources it has.
 *
 * With a display share present the two sources are summed into one track, so the recorder, the
 * chunk protocol and the server see the same single-track recording they always have. Without one,
 * the microphone stream is recorded directly — no graph, no resampling, nothing between the
 * microphone and the file that was not there before this mode existed.
 */
function buildCapture(mic: MediaStream, display: MediaStream | null): Capture {
  if (!display) return { recordStream: mic, mic, display: null, mixer: null };
  const mixer = createAudioMixer([mic, display]);
  return { recordStream: mixer.stream, mic, display, mixer };
}

export interface RecordingState {
  phase: RecordingPhase;
  /** Audio seconds captured, pauses excluded. */
  elapsedSeconds: number;
  /** Smoothed input level, 0..1. */
  level: number;
  silent: boolean;
  status: RecordingClientStatus | null;
  error: RecordingError | null;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  storageLow: boolean;
  /**
   * True while the recording runs on a different input than the one that was chosen.
   *
   * Set when the chosen microphone is refused at the start, or unplugged mid-recording. It is not
   * an error — capture continues — but it is a condition the user can act on, so it is said out
   * loud rather than swallowed (STATES.md §9).
   */
  inputFallback: boolean;
  /** Which kind of meeting the running (or last) session captures. */
  mode: CaptureMode;
  /**
   * True while an online recording is paused because the shared audio stopped arriving.
   *
   * The user pressed the browser's own "Stop sharing", or the shared window closed. Continuing on
   * the microphone alone would be the recording quietly becoming a different recording than the
   * one the user asked for, so capture pauses instead and says so; resuming asks to share again.
   */
  displayEnded: boolean;
  meetingId: string | null;
  recoverable: BufferedSession | null;
  /**
   * The limit the server stopped this session with, if it did.
   *
   * Kept apart from `error`: a limit is not a malfunction, and the hard stop at the maximum
   * session length is not even a failure — the recording is finalized and safe. Only the screen
   * decides how each of them reads.
   */
  limit: LimitErrorCode | null;
}

const INITIAL_STATE: RecordingState = {
  phase: "idle",
  elapsedSeconds: 0,
  level: 0,
  silent: false,
  status: null,
  error: null,
  wakeLockSupported: isWakeLockSupported(),
  wakeLockActive: false,
  storageLow: false,
  inputFallback: false,
  mode: "in-person",
  displayEnded: false,
  meetingId: null,
  recoverable: null,
  limit: null,
};

/**
 * Owns one recording: microphone, `MediaRecorder`, the protocol client and the
 * wake lock. Capture is deliberately independent of the network — the client
 * buffers locally and the UI reports what is and is not on the server yet.
 */
export function useRecording() {
  const { accessToken } = useAuth();
  const [state, setState] = React.useState<RecordingState>(INITIAL_STATE);
  // Bumped whenever capture is (re)built, so the device watcher re-binds to the live tracks.
  const [captureGeneration, setCaptureGeneration] = React.useState(0);

  const bufferRef = React.useRef<ChunkBuffer | null>(null);
  const clientRef = React.useRef<RecordingClient | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const captureRef = React.useRef<Capture | null>(null);
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const wakeLockRef = React.useRef<WakeLockHandle | null>(null);
  const audioSecondsRef = React.useRef(0);
  const silentSinceRef = React.useRef<number | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const formatRef = React.useRef<ReturnType<typeof selectRecordingFormat>>(null);
  // Set while a swap to another input is in flight, so the recorder we are deliberately stopping
  // is not mistaken for a second device loss.
  const swappingRef = React.useRef(false);
  const phaseRef = React.useRef<RecordingPhase>("idle");
  const modeRef = React.useRef<CaptureMode>("in-person");

  const patch = React.useCallback((changes: Partial<RecordingState>) => {
    setState((current) => ({ ...current, ...changes }));
  }, []);

  const openBuffer = React.useCallback(async (): Promise<ChunkBuffer> => {
    if (!bufferRef.current) {
      bufferRef.current = await openChunkBuffer();
    }
    return bufferRef.current;
  }, []);

  // The phase, readable from callbacks that must not close over a stale render.
  React.useEffect(() => {
    phaseRef.current = state.phase;
  }, [state.phase]);

  /**
   * Looks for audio of a session that was never finalized.
   *
   * The session currently being recorded is unfinished too, by definition, and is excluded: the
   * recovery offer is about audio nothing is taking care of any more. Rescanning after each
   * recovery is what makes a second orphaned session reachable at all — the offer used to be
   * made once, for one session, and never again.
   */
  const refreshRecoverable = React.useCallback(async () => {
    const buffer = await openBuffer();
    const liveSessionId = clientRef.current?.status.sessionId ?? null;
    const sessions = await buffer.listUnfinishedSessions();
    patch({ recoverable: sessions.find((each) => each.sessionId !== liveSessionId) ?? null });
  }, [openBuffer, patch]);

  // An unfinished session in the buffer means a previous recording was cut
  // short — its audio is still here and can be delivered.
  React.useEffect(() => {
    void refreshRecoverable().catch(() => {
      // A buffer we cannot open is reported when a recording is attempted.
    });
  }, [refreshRecoverable]);

  const releaseWakeLock = React.useCallback(() => {
    const handle = wakeLockRef.current;
    wakeLockRef.current = null;
    if (handle) void handle.release().catch(() => undefined);
    patch({ wakeLockActive: false });
  }, [patch]);

  const acquireWakeLock = React.useCallback(async () => {
    const handle = await requestWakeLock();
    wakeLockRef.current = handle;
    patch({ wakeLockActive: handle !== null });
  }, [patch]);

  /**
   * Releases the audio graph and every input feeding it.
   *
   * Both sources are stopped, not just the one the recorder was reading: a display share that
   * outlived its recording would leave the browser's "sharing your screen" strip on screen with
   * nothing behind it, which is the opposite of what this mode promises.
   */
  const releaseCapture = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const capture = captureRef.current;
    captureRef.current = null;
    capture?.mic.getTracks().forEach((track) => track.stop());
    capture?.display?.getTracks().forEach((track) => track.stop());
    capture?.recordStream.getTracks().forEach((track) => track.stop());
    void capture?.mixer?.close().catch(() => undefined);
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  const teardownCapture = React.useCallback(() => {
    recorderRef.current = null;
    releaseCapture();
    releaseWakeLock();
  }, [releaseCapture, releaseWakeLock]);

  const monitorLevel = React.useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const samples = new Float32Array(analyser.fftSize);
    let lastFrame = 0;
    let lastPublish = 0;
    let smoothed = 0;
    let published = 0;
    let publishedSilent = false;

    const tick = (timestamp: number) => {
      frameRef.current = requestAnimationFrame(tick);

      // The envelope is followed on every frame — smoothing is what turns a
      // jittery RMS reading into a level that breathes instead of strobing.
      const deltaMs = lastFrame === 0 ? 16 : timestamp - lastFrame;
      lastFrame = timestamp;

      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      smoothed = followEnvelope(smoothed, normalizeRms(Math.sqrt(sum / samples.length)), deltaMs);

      if (smoothed < SILENCE_LEVEL) {
        silentSinceRef.current ??= timestamp;
      } else {
        silentSinceRef.current = null;
      }
      const silentSince = silentSinceRef.current;
      const silent = silentSince !== null && timestamp - silentSince > SILENCE_HINT_SECONDS * 1000;

      // React only hears about the level at ~10 Hz, and only when the change is
      // large enough to see. The meter and the indicator both read this one
      // value, so they always move together.
      const levelWorthPublishing =
        timestamp - lastPublish >= 100 && Math.abs(smoothed - published) >= LEVEL_EPSILON;
      if (!levelWorthPublishing && silent === publishedSilent) return;

      lastPublish = timestamp;
      published = smoothed;
      publishedSilent = silent;

      setState((current) =>
        current.phase === "recording" ? { ...current, level: smoothed, silent } : current,
      );
    };

    frameRef.current = requestAnimationFrame(tick);
  }, []);

  /**
   * Wires a fresh stream up to the level meter and the recorder.
   *
   * Everything that carries the session — the protocol client, the offset counter, the buffer —
   * lives outside this function on purpose: capture can be rebuilt on another microphone without
   * the session noticing, which is what keeps a chunk sequence gap-free across a device swap.
   */
  const attachCapture = React.useCallback((capture: Capture, client: RecordingClient) => {
    const format = formatRef.current;
    if (!format) return;
    captureRef.current = capture;

    if (capture.mixer) {
      // The mixed signal is what is being recorded, so it is what the meter reads.
      audioContextRef.current = capture.mixer.context;
      analyserRef.current = capture.mixer.analyser;
    } else {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(capture.recordStream).connect(analyser);
      audioContextRef.current = context;
      analyserRef.current = analyser;
    }

    const recorder = new MediaRecorder(capture.recordStream, { mimeType: format.mimeType });
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size === 0) return;
      const offset = audioSecondsRef.current;
      audioSecondsRef.current += CHUNK_INTERVAL_MS / 1000;
      void event.data
        .arrayBuffer()
        .then((payload) =>
          client.pushChunk(new Uint8Array(payload), offset, CHUNK_INTERVAL_MS / 1000),
        )
        .catch(() => undefined);
    };
    recorderRef.current = recorder;
    recorder.start(CHUNK_INTERVAL_MS);
    setCaptureGeneration((generation) => generation + 1);
  }, []);

  /**
   * Continues the recording on the system default input after the current one disappeared.
   *
   * A meeting does not end because a headset was unplugged. The old recorder is stopped first and
   * its final chunk is awaited before the new one starts, so the chunks reach the server in the
   * order their offsets claim.
   */
  const continueOnDefaultInput = React.useCallback(async () => {
    const client = clientRef.current;
    const previous = recorderRef.current;
    if (!client || swappingRef.current) return;
    swappingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(null) });

      if (previous && previous.state !== "inactive") {
        await new Promise<void>((resolve) => {
          previous.onstop = () => resolve();
          previous.stop();
        });
      }
      // The shared audio survives a microphone swap: it is a different source with a different
      // lifetime, and losing the call because a headset was unplugged would be absurd.
      const capture = captureRef.current;
      const display = capture?.display ?? null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      captureRef.current = null;
      capture?.mic.getTracks().forEach((track) => track.stop());
      void capture?.mixer?.close().catch(() => undefined);
      if (!capture?.mixer) void audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
      analyserRef.current = null;

      attachCapture(buildCapture(stream, display), client);
      patch({ inputFallback: true });
      monitorLevel();
    } catch (cause) {
      // No input left at all — that is a stop, and it is said plainly rather than left to a
      // timer that quietly stops counting.
      recorderRef.current?.stop();
      teardownCapture();
      patch({
        phase: "error",
        error: { kind: "input-lost", detail: cause instanceof Error ? cause.message : undefined },
      });
    } finally {
      swappingRef.current = false;
    }
  }, [attachCapture, monitorLevel, patch, teardownCapture]);

  const start = React.useCallback(
    async (
      meetingTitle: string | null,
      summaryTemplateId: string | null = null,
      inputDeviceId: string | null = null,
      mode: CaptureMode = "in-person",
    ) => {
      modeRef.current = mode;
      patch({
        phase: "requesting",
        error: null,
        limit: null,
        inputFallback: false,
        displayEnded: false,
        mode,
      });

      const format = selectRecordingFormat();
      if (!format) {
        patch({ phase: "error", error: { kind: "unsupported" } });
        return;
      }
      formatRef.current = format;

      // The share picker is opened first, while the click that led here is still the browser's
      // idea of a user gesture, and before anything else has been set up: an online recording that
      // cannot get the meeting's sound must fail before it has opened a socket or a buffer.
      let display: MediaStream | null = null;
      if (mode === "online") {
        try {
          display = await requestDisplayAudio();
        } catch (cause) {
          const reason: DisplayCaptureFailure =
            cause instanceof DisplayCaptureError ? cause.reason : "denied";
          patch({ phase: "error", error: { kind: displayErrorKind(reason) } });
          return;
        }
      }

      const abandonDisplay = () => display?.getTracks().forEach((track) => track.stop());

      let buffer: ChunkBuffer;
      try {
        buffer = await openBuffer();
      } catch (cause) {
        abandonDisplay();
        patch({
          phase: "error",
          error: { kind: "storage", detail: cause instanceof Error ? cause.message : undefined },
        });
        return;
      }

      let stream: MediaStream;
      let usedFallbackInput = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints(inputDeviceId),
        });
      } catch (cause) {
        // A chosen input that the browser will not hand over is not a reason to refuse the
        // recording — the default one is tried, and the substitution is said out loud.
        let fallback: MediaStream | null = null;
        if (inputDeviceId !== null) {
          fallback = await navigator.mediaDevices
            .getUserMedia({ audio: audioConstraints(null) })
            .catch(() => null);
        }
        if (!fallback) {
          abandonDisplay();
          patch({
            phase: "error",
            error: {
              kind: "permission-denied",
              detail: cause instanceof Error ? cause.message : undefined,
            },
          });
          return;
        }
        stream = fallback;
        usedFallbackInput = true;
      }

      const track = stream.getAudioTracks().at(0);
      if (!track) {
        abandonDisplay();
        stream.getTracks().forEach((each) => each.stop());
        patch({ phase: "error", error: { kind: "unsupported" } });
        return;
      }

      const capture = buildCapture(stream, display);
      captureRef.current = capture;

      const client = new RecordingClient({
        url: webSocketUrl(RECORDING_PATH),
        accessToken: accessToken ?? undefined,
        buffer,
        createSocket: (url, protocols) => new WebSocket(url, protocols) as never,
        clientInfo: describeClient(),
        onStatusChange: (status) => patch({ status }),
        onFinalized: ({ meetingId }) => {
          teardownCapture();
          patch({ phase: "finalized", meetingId });
        },
        onError: (error: RecordingClientError) => {
          if (error.code === "buffer-write-failed") {
            // Audio that cannot be stored locally is never silently dropped.
            recorderRef.current?.stop();
            teardownCapture();
            patch({ phase: "error", error: { kind: "storage", detail: error.message } });
            return;
          }
          if (error.code === "limit" && error.limit) {
            // Capture stops either way — the session is over — but a hard stop at the maximum
            // length has already been finalized by the server, so it keeps the finalized phase
            // and the meeting it produced. Everything else is a refusal.
            recorderRef.current?.stop();
            teardownCapture();
            patch(
              isRecordingFinalizedDespite(error.limit)
                ? { limit: error.limit }
                : { phase: "error", limit: error.limit },
            );
          }
        },
      });
      clientRef.current = client;

      // The format announced to the server describes the track that is actually recorded. For a
      // mixed capture that is the graph's output, not the microphone that is one of its inputs —
      // the sum can carry a different rate and channel count than either source.
      const recordedTrack = capture.recordStream.getAudioTracks().at(0) ?? track;
      const audioFormat = describeAudioFormat(format, recordedTrack, capture.mixer?.context);
      await client.start({ meetingTitle, summaryTemplateId }, audioFormat);

      audioSecondsRef.current = 0;
      silentSinceRef.current = null;
      attachCapture(capture, client);

      patch({ phase: "recording", elapsedSeconds: 0, inputFallback: usedFallbackInput });
      await acquireWakeLock();
      monitorLevel();
    },
    [accessToken, acquireWakeLock, attachCapture, monitorLevel, openBuffer, patch, teardownCapture],
  );

  const pause = React.useCallback(() => {
    recorderRef.current?.pause();
    clientRef.current?.pause();
    // Both sources go quiet, not just the recorder: a pause that left the microphone light on and
    // the call still being listened to would be a pause only on the screen.
    const capture = captureRef.current;
    setCaptureEnabled([capture?.mic ?? null, capture?.display ?? null], false);
    releaseWakeLock();
    patch({ phase: "paused", level: 0, silent: false });
  }, [patch, releaseWakeLock]);

  /**
   * Continues after a pause — asking to share again first, if the share is what ended it.
   *
   * Resuming is a button press, which is the user gesture the share picker requires, so an online
   * recording whose share was stopped can be picked up exactly where it left off. A picker that is
   * dismissed, or a share that comes back without sound, leaves the recording paused and the
   * notice standing: the alternative would be resuming into a microphone-only capture of a call
   * the user cannot hear, which is the one thing this mode must never do quietly.
   */
  const resume = React.useCallback(async () => {
    const client = clientRef.current;
    const capture = captureRef.current;

    if (phaseRef.current === "paused" && modeRef.current === "online" && client && capture) {
      const needsShare = capture.display === null || capture.display.getAudioTracks().length === 0;
      if (needsShare) {
        let display: MediaStream;
        try {
          display = await requestDisplayAudio();
        } catch {
          // Still paused, still explained. Nothing was lost and nothing was faked.
          return;
        }

        const previous = recorderRef.current;
        if (previous && previous.state !== "inactive") {
          await new Promise<void>((settle) => {
            previous.onstop = () => settle();
            previous.stop();
          });
        }
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        captureRef.current = null;
        void capture.mixer?.close().catch(() => undefined);
        audioContextRef.current = null;
        analyserRef.current = null;

        setCaptureEnabled([capture.mic], true);
        attachCapture(buildCapture(capture.mic, display), client);
        client.resumeMark();
        void acquireWakeLock();
        patch({ phase: "recording", displayEnded: false });
        monitorLevel();
        return;
      }
    }

    setCaptureEnabled([capture?.mic ?? null, capture?.display ?? null], true);
    recorderRef.current?.resume();
    clientRef.current?.resumeMark();
    void acquireWakeLock();
    patch({ phase: "recording" });
  }, [acquireWakeLock, attachCapture, monitorLevel, patch]);

  /**
   * The shared audio stopped arriving — the browser's own "Stop sharing", or the window closed.
   *
   * This pauses rather than finalizes. Finalizing would end a meeting the user is very likely
   * still in, over what is often a misclick, and there is nothing to gain from it: paused audio is
   * as safe as finalized audio, the buffer is untouched, and stopping remains one hold away. What
   * it must not do is carry on: red leaves the screen, the timer stops, and the notice says the
   * call's sound is no longer being captured.
   */
  const onDisplayEnded = React.useCallback(() => {
    if (phaseRef.current !== "recording" && phaseRef.current !== "paused") return;
    const capture = captureRef.current;
    if (!capture?.display) return;
    // A recording that is already paused is not paused twice: the mark stream has to stay
    // balanced, or the pipeline maps audio time back to the wrong wall clock.
    if (phaseRef.current === "recording") {
      recorderRef.current?.pause();
      clientRef.current?.pause();
    }
    capture.display.getTracks().forEach((track) => track.stop());
    // Dropped from the capture, so resuming knows it has to ask for the share again.
    captureRef.current = { ...capture, display: null };
    setCaptureEnabled([capture.mic], false);
    releaseWakeLock();
    patch({ phase: "paused", level: 0, silent: false, displayEnded: true });
  }, [patch, releaseWakeLock]);

  const stop = React.useCallback(() => {
    patch({ phase: "finalizing" });
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // The last partial chunk is delivered before `session.end` is sent, so the
      // sequence the server checks against is complete.
      recorder.onstop = () => clientRef.current?.end();
      recorder.stop();
    } else {
      clientRef.current?.end();
    }
    releaseWakeLock();
  }, [patch, releaseWakeLock]);

  /** Delivers the buffered audio of a session that was cut short. */
  const recover = React.useCallback(
    async (session: BufferedSession) => {
      // Recovering replaces the protocol client, so it must never run while one is carrying a
      // live recording — that would cut the running session loose to finalize an older one.
      if (phaseRef.current === "recording" || phaseRef.current === "paused") return;
      const buffer = await openBuffer();
      const client = new RecordingClient({
        url: webSocketUrl(RECORDING_PATH),
        accessToken: accessToken ?? undefined,
        buffer,
        createSocket: (url, protocols) => new WebSocket(url, protocols) as never,
        clientInfo: describeClient(),
        onStatusChange: (status) => patch({ status }),
        onFinalized: ({ meetingId }) => {
          patch({ phase: "finalized", meetingId });
          // A device can hold more than one orphaned session; the next one is offered right away.
          void refreshRecoverable().catch(() => undefined);
        },
        onError: (error: RecordingClientError) => {
          if (error.code === "limit" && error.limit) {
            patch(
              isRecordingFinalizedDespite(error.limit)
                ? { limit: error.limit }
                : { phase: "error", limit: error.limit },
            );
          }
        },
      });
      clientRef.current = client;
      patch({ phase: "finalizing", recoverable: null });
      await client.resume(session);
      client.end();
    },
    [accessToken, openBuffer, patch, refreshRecoverable],
  );

  const discardRecoverable = React.useCallback(
    async (session: BufferedSession) => {
      const buffer = await openBuffer();
      await buffer.deleteSession(session.sessionId);
      await refreshRecoverable();
    },
    [openBuffer, refreshRecoverable],
  );

  /**
   * Returns the session state to rest after a finished or failed one.
   *
   * The state now outlives the recording screen, so the outcome of the last recording would
   * otherwise still be on screen the next time it is opened. A live recording is never reset —
   * reopening the screen re-attaches to it, which is the whole point.
   */
  const reset = React.useCallback(() => {
    if (phaseRef.current === "recording" || phaseRef.current === "paused") return;
    if (phaseRef.current === "finalizing") return;
    // A failed session can leave a client still trying to reconnect; dropping the reference
    // without disposing it would leave that running with nothing left to report to.
    clientRef.current?.dispose();
    clientRef.current = null;
    patch({
      phase: "idle",
      elapsedSeconds: 0,
      level: 0,
      silent: false,
      status: null,
      error: null,
      wakeLockActive: false,
      storageLow: false,
      inputFallback: false,
      displayEnded: false,
      meetingId: null,
      limit: null,
    });
  }, [patch]);

  // Elapsed time is audio time: it advances only while chunks are being captured.
  React.useEffect(() => {
    if (state.phase !== "recording") return;
    const handle = window.setInterval(() => {
      patch({ elapsedSeconds: audioSecondsRef.current });
    }, 250);
    return () => window.clearInterval(handle);
  }, [state.phase, patch]);

  /**
   * Watches the input the recording is running on.
   *
   * A track that ends is the browser telling us the microphone is gone — unplugged, switched off,
   * taken by something else. `devicechange` is watched as well because some browsers report the
   * disappearance only through the device list; both lead to the same place, which is a recording
   * that carries on somewhere else.
   */
  React.useEffect(() => {
    if (state.phase !== "recording" && state.phase !== "paused") return;
    const track = captureRef.current?.mic.getAudioTracks().at(0);
    if (!track) return;

    const onEnded = () => void continueOnDefaultInput();
    const onDeviceChange = () => {
      if (track.readyState === "ended") void continueOnDefaultInput();
    };

    track.addEventListener("ended", onEnded);
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      track.removeEventListener("ended", onEnded);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [state.phase, captureGeneration, continueOnDefaultInput]);

  /**
   * Watches the shared audio of an online recording.
   *
   * The browser gives the user a stop-sharing control of its own, outside the app, and pressing it
   * ends the track without telling anything else. This is the only place that finds out, so it is
   * the place that has to be honest about it.
   */
  React.useEffect(() => {
    if (state.phase !== "recording" && state.phase !== "paused") return;
    const track = captureRef.current?.display?.getAudioTracks().at(0);
    if (!track) return;

    const handle = () => onDisplayEnded();
    track.addEventListener("ended", handle);
    return () => track.removeEventListener("ended", handle);
  }, [state.phase, captureGeneration, onDisplayEnded]);

  // Wake locks are dropped when a tab is hidden and must be taken again.
  React.useEffect(() => {
    if (state.phase !== "recording") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [state.phase, acquireWakeLock]);

  // Storage pressure only matters while audio is actually piling up locally.
  React.useEffect(() => {
    if ((state.status?.pendingChunks ?? 0) === 0) return;
    let active = true;
    void storageHeadroom().then((headroom) => {
      if (active && headroom !== null) {
        patch({ storageLow: headroom < STORAGE_PRESSURE_THRESHOLD });
      }
    });
    return () => {
      active = false;
    };
  }, [state.status?.pendingChunks, patch]);

  React.useEffect(
    () => () => {
      clientRef.current?.dispose();
      teardownCapture();
    },
    [teardownCapture],
  );

  return { state, start, pause, resume, stop, reset, recover, discardRecoverable };
}

/** Everything the app can know and do about the one recording session it owns. */
export type RecordingSession = ReturnType<typeof useRecording>;
