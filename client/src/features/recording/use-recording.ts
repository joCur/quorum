import * as React from "react";
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

/** Route the recording endpoint is mounted on server-side. */
export const RECORDING_PATH = "ws/recording";

/** Chunk length in milliseconds — the 1–2 s window ADR-002 asks for. */
export const CHUNK_INTERVAL_MS = 1_000;

/** How long the input may stay near silence before the UI says something. */
export const SILENCE_HINT_SECONDS = 10;

/** Free storage fraction below which the buffer warning escalates. */
export const STORAGE_PRESSURE_THRESHOLD = 0.1;

export type RecordingPhase =
  "idle" | "requesting" | "recording" | "paused" | "finalizing" | "finalized" | "error";

export interface RecordingError {
  /** Distinguishes the cases the UI must explain differently. */
  kind: "permission-denied" | "unsupported" | "storage" | "connection" | "unknown";
  detail?: string | undefined;
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
  meetingId: string | null;
  recoverable: BufferedSession | null;
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
  meetingId: null,
  recoverable: null,
};

/**
 * Owns one recording: microphone, `MediaRecorder`, the protocol client and the
 * wake lock. Capture is deliberately independent of the network — the client
 * buffers locally and the UI reports what is and is not on the server yet.
 */
export function useRecording() {
  const { accessToken } = useAuth();
  const [state, setState] = React.useState<RecordingState>(INITIAL_STATE);

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
    let lastUpdate = 0;

    const tick = (timestamp: number) => {
      frameRef.current = requestAnimationFrame(tick);
      // The indicator is throttled to roughly 10 Hz: enough to read as "it moves
      // with your voice", cheap enough to run for an hour.
      if (timestamp - lastUpdate < 100) return;
      lastUpdate = timestamp;

      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      // Perceptual-ish curve so ordinary speech uses most of the range.
      const level = Math.min(1, Math.sqrt(rms) * 3);

      const now = timestamp;
      if (level < 0.02) {
        silentSinceRef.current ??= now;
      } else {
        silentSinceRef.current = null;
      }
      const silentSince = silentSinceRef.current;
      const silent = silentSince !== null && now - silentSince > SILENCE_HINT_SECONDS * 1000;

      setState((current) =>
        current.phase === "recording" ? { ...current, level, silent } : current,
      );
    };

    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const start = React.useCallback(
    async (meetingTitle: string | null) => {
      patch({ phase: "requesting", error: null });

      const format = selectRecordingFormat();
      if (!format) {
        patch({ phase: "error", error: { kind: "unsupported" } });
        return;
      }

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
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (cause) {
        patch({
          phase: "error",
          error: {
            kind: "permission-denied",
            detail: cause instanceof Error ? cause.message : undefined,
          },
        });
        return;
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
          }
        },
      });
      clientRef.current = client;

      const audioFormat = describeAudioFormat(format, track);
      await client.start(meetingTitle, audioFormat);

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

      audioSecondsRef.current = 0;
      silentSinceRef.current = null;
      patch({ phase: "recording", elapsedSeconds: 0 });
      await acquireWakeLock();
      monitorLevel();
    },
    [accessToken, acquireWakeLock, monitorLevel, openBuffer, patch, teardownCapture],
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
