/**
 * The remembered microphone choice.
 *
 * A per-device convenience, so it lives in `localStorage` rather than in the account: the input a
 * user picks is a property of the machine they are sitting at, not of who they are. Every access
 * is wrapped — private modes and blocked site data make both reads and writes throw, and a
 * microphone picker is never worth taking the recording screen down for.
 */
const STORAGE_KEY = "quorum.recording.input-device";

export function readRememberedInputDevice(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null || stored === "" ? null : stored;
  } catch {
    return null;
  }
}

export function rememberInputDevice(deviceId: string | null): void {
  try {
    if (deviceId === null || deviceId === "") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, deviceId);
  } catch {
    // A choice that cannot be remembered still applies to this recording.
  }
}

/** One audio input as the picker needs it: an id to constrain with and something to call it. */
export interface AudioInput {
  deviceId: string;
  label: string;
}

/**
 * The audio inputs, as far as the browser is willing to describe them.
 *
 * Devices whose label is empty are dropped rather than renamed to "Microphone 2": before the
 * microphone permission is granted, every browser returns an unlabeled list, and a choice between
 * names the user cannot map to hardware is not a choice. The picker therefore stays away until
 * the labels are real — see `useAudioInputs`.
 */
export function toAudioInputs(devices: readonly MediaDeviceInfo[]): AudioInput[] {
  return devices
    .filter((device) => device.kind === "audioinput" && device.label !== "")
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/** Whether a remembered choice still points at something that exists. */
export function isStillAvailable(deviceId: string | null, inputs: readonly AudioInput[]): boolean {
  return deviceId !== null && inputs.some((input) => input.deviceId === deviceId);
}
