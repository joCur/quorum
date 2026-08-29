/**
 * Screen Wake Lock while recording, so a phone left on the table does not
 * suspend the tab mid-meeting.
 *
 * The API is unavailable in some browsers — notably older iOS Safari. That is a
 * platform limitation, not an error: capture continues either way, and the UI
 * says plainly that the screen may turn itself off.
 */
export interface WakeLockHandle {
  release: () => Promise<void>;
}

export function isWakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

export async function requestWakeLock(): Promise<WakeLockHandle | null> {
  if (!isWakeLockSupported()) return null;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    return { release: () => sentinel.release() };
  } catch {
    // Denied (for example because the tab is hidden) — not worth surfacing.
    return null;
  }
}
