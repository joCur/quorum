import * as React from "react";
import type { RecordingSession } from "@/features/recording/use-recording";

/**
 * The one recording session the signed-in app owns, made available to every screen.
 *
 * The context lives apart from the provider that fills it so that ambient consumers — the
 * recording bar, the recovery card — depend on the shape of a session rather than on the
 * machinery that produces one: microphone, WebSocket and build-time configuration included.
 */
const RecordingContext = React.createContext<RecordingSession | null>(null);

/**
 * The recording session in scope, or `null` where there is none.
 *
 * The sign-in screens live outside the provider on purpose — there is nothing to record there —
 * so ambient consumers have to be able to say "no session here".
 */
export function useRecordingSession(): RecordingSession | null {
  return React.useContext(RecordingContext);
}

/** The recording session, for screens that cannot do their job without one. */
export function useRequiredRecordingSession(): RecordingSession {
  const session = useRecordingSession();
  if (!session) {
    throw new Error("useRequiredRecordingSession must be used inside a RecordingProvider");
  }
  return session;
}

/** Supplies a session to a subtree. Used by the provider, and by tests that stand in for one. */
export const RecordingSessionProvider = RecordingContext.Provider;
