/**
 * The two kinds of meeting Quorum can capture.
 *
 * `in-person` is the microphone alone — everyone is in the room, one input hears all of them.
 * `online` adds the audio of a meeting that is happening on this machine: the browser's own
 * share picker hands over a window or the whole screen, and Quorum keeps only its sound.
 */
export type CaptureMode = "in-person" | "online";

export const CAPTURE_MODES: readonly CaptureMode[] = ["in-person", "online"];

/** The remembered mode, so a user who records online meetings is not asked twice a day. */
const STORAGE_KEY = "quorum.recording.capture-mode";

export function isCaptureMode(value: unknown): value is CaptureMode {
  return value === "in-person" || value === "online";
}

export function readRememberedCaptureMode(): CaptureMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isCaptureMode(stored) ? stored : "in-person";
  } catch {
    // Private modes and blocked site data make even reads throw; the default is a fine answer.
    return "in-person";
  }
}

export function rememberCaptureMode(mode: CaptureMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // A choice that cannot be remembered still applies to this recording.
  }
}
