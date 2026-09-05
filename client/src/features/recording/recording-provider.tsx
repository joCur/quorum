import * as React from "react";
import { RecordingSessionProvider } from "@/features/recording/recording-context";
import { useRecording } from "@/features/recording/use-recording";
import { useBlockReloadWhile } from "@/features/pwa/reload-guard";

/**
 * App-level ownership of the one recording a signed-in user can have running.
 *
 * The microphone, the `MediaRecorder`, the protocol client, the IndexedDB buffer and the timers
 * used to be owned by the recording route, which meant that leaving the screen — a tab, a link,
 * a back-swipe — tore all of it down mid-meeting and left half a meeting behind. Ownership moves
 * up to here instead, so navigation is just navigation: the session keeps running, and the screen
 * re-attaches to it when it comes back.
 *
 * A React context rather than a module-level store, for two reasons. The session needs the access
 * token from the auth context and must not outlive it, so its lifetime is exactly the lifetime of
 * a mounted subtree — mount it under the auth gate and signing out disposes the client for free.
 * And the state is React state that several screens render; a module-level store would have to
 * grow its own subscription mechanism and its own auth wiring to arrive at the same place.
 */
export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const session = useRecording();
  const { phase } = session.state;
  const live = phase === "recording" || phase === "paused";

  /**
   * Closing the app mid-recording is the one exit that is genuinely destructive.
   *
   * In-app navigation deliberately does not prompt: the session survives it. Leaving the page
   * does not — the seconds still in the buffer would be, so the browser is asked to confirm.
   * The guard lives here rather than on the recording screen because the recording is no longer
   * on the recording screen.
   */
  React.useEffect(() => {
    if (!live) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);

  /**
   * The same session, seen by the update flow: a pending app update must not reload the page out
   * from under a recording. Wider than `live` on purpose — `finalizing` is the phase that flushes
   * the last chunks to the server, so it is the worst possible moment to disappear, and
   * `requesting` holds a microphone permission dialog the reload would cancel.
   */
  const inFlight =
    phase === "requesting" || phase === "recording" || phase === "paused" || phase === "finalizing";
  useBlockReloadWhile(inFlight, "recording");

  return <RecordingSessionProvider value={session}>{children}</RecordingSessionProvider>;
}
