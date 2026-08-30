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
  kind: "permission-denied" | "unsupported" | "storage" | "connection" | "input-lost" | "unknown";
  detail?: string | undefined;
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
  const streamRef = React.useRef<MediaStream | null>(null);
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

  const patch = React.useCallback((changes: Partial<RecordingState>) => {
    setState((current) => ({ ...current, ...changes }));
  }, []);

  const openBuffer = React.useCallback(async (): Promise<ChunkBuffer> => {
    if (!bufferRef.current) {
      bufferRef.current = await openChunkBuffer();
    }
    return bufferRef.current;
  }, []);

  // An unfinished session in the buffer means a previous recording was cut
  // short — its audio is still here and can be delivered.
  React.useEffect(() => {
    let active = true;
    void openBuffer()
      .then((buffer) => buffer.listUnfinishedSessions())
      .then((sessions) => {
        const first = sessions.at(0);
        if (active && first) patch({ recoverable: first });
      })
      .catch(() => {
        // A buffer we cannot open is reported when a recording is attempted.
      });
    return () => {
      active = false;
    };
  }, [openBuffer, patch]);

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

  const teardownCapture = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
    releaseWakeLock();
  }, [releaseWakeLock]);

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
  const attachCapture = React.useCallback((stream: MediaStream, client: RecordingClient) => {
    const format = formatRef.current;
    if (!format) return;
    streamRef.current = stream;

    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = context;
    analyserRef.current = analyser;

    const recorder = new MediaRecorder(stream, { mimeType: format.mimeType });
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
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
      analyserRef.current = null;

      attachCapture(stream, client);
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
    ) => {
      patch({ phase: "requesting", error: null, limit: null, inputFallback: false });

      const format = selectRecordingFormat();
      if (!format) {
        patch({ phase: "error", error: { kind: "unsupported" } });
        return;
      }
      formatRef.current = format;

      let buffer: ChunkBuffer;
      try {
        buffer = await openBuffer();
      } catch (cause) {
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
        stream.getTracks().forEach((each) => each.stop());
        patch({ phase: "error", error: { kind: "unsupported" } });
        return;
      }
      streamRef.current = stream;

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

      const audioFormat = describeAudioFormat(format, track);
      await client.start({ meetingTitle, summaryTemplateId }, audioFormat);

      audioSecondsRef.current = 0;
      silentSinceRef.current = null;
      attachCapture(stream, client);

      patch({ phase: "recording", elapsedSeconds: 0, inputFallback: usedFallbackInput });
      await acquireWakeLock();
      monitorLevel();
    },
    [accessToken, acquireWakeLock, attachCapture, monitorLevel, openBuffer, patch, teardownCapture],
  );

  const pause = React.useCallback(() => {
    recorderRef.current?.pause();
    clientRef.current?.pause();
    releaseWakeLock();
    patch({ phase: "paused", level: 0, silent: false });
  }, [patch, releaseWakeLock]);

  const resume = React.useCallback(() => {
    recorderRef.current?.resume();
    clientRef.current?.resumeMark();
    void acquireWakeLock();
    patch({ phase: "recording" });
  }, [acquireWakeLock, patch]);

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
      const buffer = await openBuffer();
      const client = new RecordingClient({
        url: webSocketUrl(RECORDING_PATH),
        accessToken: accessToken ?? undefined,
        buffer,
        createSocket: (url, protocols) => new WebSocket(url, protocols) as never,
        clientInfo: describeClient(),
        onStatusChange: (status) => patch({ status }),
        onFinalized: ({ meetingId }) => patch({ phase: "finalized", meetingId, recoverable: null }),
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
    [accessToken, openBuffer, patch],
  );

  const discardRecoverable = React.useCallback(
    async (session: BufferedSession) => {
      const buffer = await openBuffer();
      await buffer.deleteSession(session.sessionId);
      patch({ recoverable: null });
    },
    [openBuffer, patch],
  );

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
    const track = streamRef.current?.getAudioTracks().at(0);
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

  return { state, start, pause, resume, stop, recover, discardRecoverable };
}
