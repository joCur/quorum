import type { AudioFormat } from "@quorum/shared";

/**
 * Container and codec selection.
 *
 * Nothing is re-encoded in the browser: whatever `MediaRecorder` produces is
 * what gets streamed, and the announced format tells the server how to read it.
 * Chromium and Firefox give WebM/Opus; Safari gives MP4/AAC. Both are accepted
 * server-side, so the only job here is to name the result truthfully.
 */
interface Candidate {
  mimeType: string;
  codec: string;
  container: string;
}

const CANDIDATES: readonly Candidate[] = [
  { mimeType: "audio/webm;codecs=opus", codec: "opus", container: "webm" },
  { mimeType: "audio/webm", codec: "opus", container: "webm" },
  { mimeType: "audio/ogg;codecs=opus", codec: "opus", container: "ogg" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2", codec: "mp4a", container: "mp4" },
  { mimeType: "audio/mp4", codec: "aac", container: "mp4" },
];

export interface SelectedFormat {
  /** Passed to the `MediaRecorder` constructor. */
  mimeType: string;
  container: string;
  codec: string;
}

/** The first candidate this browser can actually record, or null. */
export function selectRecordingFormat(
  isTypeSupported: (mimeType: string) => boolean = (mimeType) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType),
): SelectedFormat | null {
  for (const candidate of CANDIDATES) {
    if (isTypeSupported(candidate.mimeType)) {
      return {
        mimeType: candidate.mimeType,
        container: candidate.container,
        codec: candidate.codec,
      };
    }
  }
  return null;
}

/** Announced in `session.start`; the sample rate comes from the live track. */
export function describeAudioFormat(format: SelectedFormat, track: MediaStreamTrack): AudioFormat {
  const settings = track.getSettings();
  return {
    codec: format.codec,
    container: format.container,
    sampleRate: settings.sampleRate ?? 48_000,
    channels: settings.channelCount ?? 1,
  };
}

/** Reported in `session.start` so the server can tell platforms apart. */
export function describeClient(): { platform: string; userAgent: string } {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return {
    platform: mobile ? "web-mobile" : "web-desktop",
    userAgent: navigator.userAgent,
  };
}
