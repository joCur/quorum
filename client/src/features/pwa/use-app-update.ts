import * as React from "react";
import { APP_VERSION } from "@/env";
import { isReloadUnsafe, subscribeReloadSafety } from "@/features/pwa/reload-guard";
import { applyUpdate, readDeployedVersion, startUpdateWatch } from "@/features/pwa/update-watch";

/**
 * How long a pending update waits for an answer before it stops waiting for one.
 *
 * The deadline does not force anything on a user who is working. It only removes the case where
 * the prompt is ignored forever: once it expires, the app reloads itself the next time the tab
 * is in the background and nothing destructive is in flight. A tab nobody is looking at loses
 * nothing by reloading, and a tab somebody *is* looking at simply keeps the prompt.
 */
export const UPDATE_DEADLINE_MS = 30 * 60 * 1000;

export interface AppUpdate {
  /** A newer version is available and the running shell is out of date. */
  available: boolean;
  /** Reloading right now would destroy work in progress — a running recording. */
  blocked: boolean;
  /** Applies the update by reloading onto the shell the service worker already serves. */
  apply: () => void;
}

export interface AppUpdateOptions {
  container?: ServiceWorkerContainer | null;
  readVersion?: () => Promise<string | null>;
  runningVersion?: string;
  checkIntervalMs?: number;
  minCheckSpacingMs?: number;
  deadlineMs?: number;
  reload?: () => void;
}

/**
 * Watches for a newer deployment and decides when it may be applied.
 *
 * Applying is only ever a reload. The service worker generated for this app activates on its own
 * (`skipWaiting`), so by the time this hook reports an update the new shell is already what the
 * next navigation will be answered with — this hook shortens the wait, it does not create the
 * path. That is why an ignored prompt is not a stuck user: the update lands on the next launch
 * regardless.
 */
export function useAppUpdate(options: AppUpdateOptions = {}): AppUpdate {
  const {
    readVersion,
    runningVersion = APP_VERSION,
    checkIntervalMs,
    minCheckSpacingMs,
    deadlineMs = UPDATE_DEADLINE_MS,
    reload,
  } = options;

  const [available, setAvailable] = React.useState(false);
  const [blocked, setBlocked] = React.useState(isReloadUnsafe);
  const [expired, setExpired] = React.useState(false);

  const container =
    options.container ??
    (typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : null);

  // Held in a ref so that a caller passing fresh object identities each render cannot restart the
  // watch and re-run its first check. The initial value is the one the first render saw, so the
  // watch below starts with the right collaborators before this effect has run at all.
  const deps = React.useRef({ container, readVersion, runningVersion, reload });
  React.useEffect(() => {
    deps.current = { container, readVersion, runningVersion, reload };
  }, [container, readVersion, runningVersion, reload]);

  React.useEffect(() => {
    const watch = startUpdateWatch({
      container: deps.current.container,
      runningVersion: deps.current.runningVersion,
      readDeployedVersion: () => (deps.current.readVersion ?? readDeployedVersion)(),
      onUpdateReady: () => setAvailable(true),
      ...(checkIntervalMs === undefined ? {} : { checkIntervalMs }),
      ...(minCheckSpacingMs === undefined ? {} : { minCheckSpacingMs }),
    });
    return () => watch.stop();
  }, [checkIntervalMs, minCheckSpacingMs]);

  React.useEffect(() => subscribeReloadSafety(() => setBlocked(isReloadUnsafe())), []);

  React.useEffect(() => {
    if (!available) return;
    const timer = window.setTimeout(() => setExpired(true), deadlineMs);
    return () => window.clearTimeout(timer);
  }, [available, deadlineMs]);

  const apply = React.useCallback(() => {
    void applyUpdate(
      deps.current.container,
      deps.current.reload ?? (() => window.location.reload()),
    );
  }, []);

  // The unattended path: an expired prompt applies itself, but only while the tab is hidden and
  // nothing destructive is running. Both conditions are re-checked on every event that could
  // have changed them, so a tab that is backgrounded an hour later still catches up.
  React.useEffect(() => {
    if (!expired || !available) return;
    const attempt = () => {
      if (isReloadUnsafe() || document.visibilityState !== "hidden") return;
      apply();
    };
    document.addEventListener("visibilitychange", attempt);
    attempt();
    return () => document.removeEventListener("visibilitychange", attempt);
  }, [expired, available, blocked, apply]);

  return { available, blocked, apply };
}
