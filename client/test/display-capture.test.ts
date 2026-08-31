import { describe, expect, it, vi } from "vitest";
import {
  DisplayCaptureError,
  displayCaptureConstraints,
  displayCaptureSupport,
  requestDisplayAudio,
} from "@/features/recording/display-capture";

/**
 * The promise of the online mode is a negative one: nothing from the screen is kept.
 *
 * A promise like that is only worth making if it is enforced in code rather than in copy, so these
 * tests assert the enforcement — the video track is stopped and removed before the stream is
 * handed to anything, and a share that turns out to be silent is released rather than quietly
 * turned into a microphone-only recording.
 */

function track(kind: "audio" | "video") {
  return { kind, stop: vi.fn(), readyState: "live", enabled: true } as unknown as MediaStreamTrack;
}

function fakeDisplayStream(tracks: MediaStreamTrack[]): MediaStream {
  const held = [...tracks];
  return {
    getTracks: () => [...held],
    getVideoTracks: () => held.filter((each) => each.kind === "video"),
    getAudioTracks: () => held.filter((each) => each.kind === "audio"),
    removeTrack: (target: MediaStreamTrack) => {
      const at = held.indexOf(target);
      if (at >= 0) held.splice(at, 1);
    },
  } as unknown as MediaStream;
}

function mediaDevices(getDisplayMedia: unknown): MediaDevices {
  return { getDisplayMedia } as unknown as MediaDevices;
}

describe("what the mode can say before the picker opens", () => {
  it("reports the capability when the browser has the API", () => {
    expect(displayCaptureSupport(mediaDevices(vi.fn()))).toBe("available");
  });

  it("reports the absence rather than guessing, so the mode can explain instead of failing", () => {
    expect(displayCaptureSupport(mediaDevices(undefined))).toBe("unsupported");
    expect(displayCaptureSupport(undefined)).toBe("unsupported");
  });
});

describe("the share request", () => {
  it("asks for sound with the browser's own processing switched off", () => {
    const constraints = displayCaptureConstraints();

    // Echo cancellation and noise suppression are tuned for a voice in a room; run over a clean
    // digital feed of other people talking, they remove speech the transcript needs.
    expect(constraints.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it("asks for the sound of a window or a screen, not only of a tab", () => {
    // Native meeting apps are the likelier case; these are the hints that make their sound
    // available at all on Chromium, and browsers that do not know them ignore them.
    const constraints = displayCaptureConstraints() as Record<string, unknown>;
    expect(constraints["systemAudio"]).toBe("include");
    expect(constraints["windowAudio"]).toBe("system");
  });

  it("asks for the least video the API will accept, since none of it is kept", () => {
    expect(displayCaptureConstraints().video).toMatchObject({ frameRate: { max: 1 } });
  });
});

describe("requesting the meeting's sound", () => {
  it("stops and removes the video track before anything can look at the stream", async () => {
    const video = track("video");
    const audio = track("audio");
    const stream = await requestDisplayAudio(
      mediaDevices(async () => fakeDisplayStream([video, audio])),
    );

    expect(video.stop).toHaveBeenCalledOnce();
    expect(stream.getVideoTracks()).toHaveLength(0);
    expect(stream.getTracks()).toEqual([audio]);
    // The audio is untouched — the whole point of the exercise.
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it("refuses a share that carries no sound, and releases it completely", async () => {
    const video = track("video");

    await expect(
      requestDisplayAudio(mediaDevices(async () => fakeDisplayStream([video]))),
    ).rejects.toMatchObject({ reason: "no-audio" });

    // Nothing is left sharing in the background after a start that did not happen.
    expect(video.stop).toHaveBeenCalled();
  });

  it("reports a dismissed picker as a refusal rather than as a malfunction", async () => {
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });

    await expect(
      requestDisplayAudio(
        mediaDevices(async () => {
          throw denied;
        }),
      ),
    ).rejects.toMatchObject({ reason: "denied" });
  });

  it("reports a browser without screen capture without calling anything", async () => {
    const error = await requestDisplayAudio(mediaDevices(undefined)).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(DisplayCaptureError);
    expect((error as DisplayCaptureError).reason).toBe("unsupported");
  });
});
