/** The worker Workbox generates at build time. */
export const SERVICE_WORKER_URL = "/sw.js";

/**
 * Registers the service worker.
 *
 * The plugin's own injected registration script is switched off (`injectRegister: false`) so that
 * this one line lives in the app, next to the update flow that depends on it. There is nothing
 * clever here — activation and cache lifecycle are the worker's own business — but registration
 * has to happen somewhere, and a failure to register is an app that silently stops updating, so
 * it is reported rather than swallowed.
 *
 * Development has no generated worker, and registering a missing one would leave a 404 in the
 * console on every reload.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" }).catch((error: unknown) => {
    console.error("Service worker registration failed; the app will not update itself", error);
  });
}
