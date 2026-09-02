import * as React from "react";

/**
 * The registry of reasons a reload would destroy work that is still only in this tab.
 *
 * A service-worker update can be applied at any moment, but not every moment survives it: the
 * seconds of audio still sitting in the recording buffer are gone if the page goes away, and the
 * IndexedDB buffer is a recovery net for crashes, not a licence to cause them.
 *
 * A module-level registry rather than a React context, because the two sides sit on opposite
 * ends of the tree. The update prompt is mounted above the router — it has to be able to appear
 * on the signed-out screens too — while the recording session lives under the auth gate, so the
 * prompt cannot read the recording state through React at all.
 */
const reasons = new Set<string>();
const listeners = new Set<() => void>();

/** Whether reloading right now would throw away work in progress. */
export function isReloadUnsafe(): boolean {
  return reasons.size > 0;
}

/** Marks a reload as destructive until the returned function is called. */
export function blockReload(reason: string): () => void {
  reasons.add(reason);
  notify();
  return () => {
    reasons.delete(reason);
    notify();
  };
}

/** Notifies when the answer to `isReloadUnsafe` may have changed. */
export function subscribeReloadSafety(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Holds a reload block for as long as `active` stays true. */
export function useBlockReloadWhile(active: boolean, reason: string): void {
  React.useEffect(() => {
    if (!active) return;
    return blockReload(reason);
  }, [active, reason]);
}

/** Test seam: forgets every block, so one test's session cannot leak into the next. */
export function resetReloadGuard(): void {
  reasons.clear();
  notify();
}
