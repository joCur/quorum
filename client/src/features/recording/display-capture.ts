/**
 * Capturing the sound of a meeting that is running on this machine.
 *
 * The screen-capture API has no sound-only dialog, by browser design: the operating system's
 * picker must show the user what is being shared, so a video track always comes back. Quorum
 * throws that track away the moment the stream arrives — before anything is recorded, buffered or
 * sent — and mixes only the audio into the chunk pipeline. Nothing from the screen is stored or
 * transmitted, and the mode's copy says exactly that, because for a privacy product "we only take
 * the sound" is a sentence that has to be true.
 *
 * What the browser will actually hand over is not knowable in advance. Chromium on Windows and on
 * macOS 14.2+ offers system audio for a window or the whole screen, and tab audio for a tab; other
 * browsers and older systems offer none, and the user can always leave the checkbox unticked.
 * There is no API that answers "will there be audio?" ahead of the picker, so the honest design is
 * to ask, look at what came back, and say plainly when it carries no sound.
 */

/** What the mode can promise before the picker is opened. */
export type DisplayCaptureSupport =
  /** The API exists — audio still depends on the picker and on the platform. */
  | "available"
  /** No screen capture at all: iOS, most mobile browsers, insecure contexts. */
  | "unsupported";

export type DisplayCaptureFailure =
  /** The picker was dismissed or the permission refused. */
  | "denied"
  /** A stream came back, but with no audio track in it. */
  | "no-audio"
  /** The browser cannot capture a display at all. */
  | "unsupported";

export class DisplayCaptureError extends Error {
  readonly reason: DisplayCaptureFailure;

  constructor(reason: DisplayCaptureFailure, cause?: unknown) {
    super(`display capture failed: ${reason}`);
    this.name = "DisplayCaptureError";
    this.reason = reason;
    if (cause instanceof Error) this.cause = cause;
  }
}

/** Whether this browser has the screen-capture API at all. */
export function displayCaptureSupport(
  media: MediaDevices | undefined = navigator.mediaDevices,
): DisplayCaptureSupport {
  return typeof media?.getDisplayMedia === "function" ? "available" : "unsupported";
}

/**
 * The constraints the share request is made with.
 *
 * `systemAudio: "include"` and `windowAudio: "system"` are Chromium's controls for offering sound
 * alongside a screen or a single window; browsers that do not know them ignore them, which is why
 * they are safe to send unconditionally. The three processing flags are off on purpose: echo
 * cancellation and noise suppression are tuned for a voice picked up by a microphone, and running
 * them over a clean digital feed of other people's voices removes speech the transcript needs.
 *
 * The video the picker insists on is asked for at the smallest, slowest thing that is still a
 * valid request — the track is stopped before a frame of it is ever read.
 */
export function displayCaptureConstraints(): DisplayMediaStreamOptions {
  return {
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: { frameRate: { max: 1 } },
    // Chromium-only hints; unknown members of this dictionary are ignored elsewhere.
    ...({
      systemAudio: "include",
      windowAudio: "system",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    } as DisplayMediaStreamOptions),
  };
}

/**
 * Asks for the meeting's sound and returns a stream that holds nothing but sound.
 *
 * The video track is stopped and removed here rather than at the call site, so there is exactly
 * one place in the app where a display video track can exist and it is three lines long. A stream
 * that turns out to carry no audio is released completely and reported as `no-audio` — the start
 * is refused rather than quietly turned into a microphone-only recording under a mode the user
 * chose for the opposite reason.
 */
export async function requestDisplayAudio(
  media: MediaDevices | undefined = navigator.mediaDevices,
): Promise<MediaStream> {
  if (displayCaptureSupport(media) !== "available") {
    throw new DisplayCaptureError("unsupported");
  }

  let stream: MediaStream;
  try {
    stream = await media!.getDisplayMedia(displayCaptureConstraints());
  } catch (cause) {
    throw new DisplayCaptureError("denied", cause);
  }

  // Immediately, unconditionally, before anything else looks at this stream.
  for (const video of stream.getVideoTracks()) {
    video.stop();
    stream.removeTrack(video);
  }

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new DisplayCaptureError("no-audio");
  }

  return stream;
}
