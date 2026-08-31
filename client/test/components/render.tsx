import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { RecordingSessionProvider } from "@/features/recording/recording-context";
import type { RecordingSession, RecordingState } from "@/features/recording/use-recording";
import i18n from "@/i18n";

/**
 * Renders a component inside the providers the app always gives it.
 *
 * The real i18n instance is used rather than a stub, on purpose: a component referencing a key
 * that does not exist renders the key itself, and assertions on the actual English strings turn
 * that into a failing test. A stub that echoed keys back would hide exactly that bug.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions & { route?: string; recording?: RecordingSession | null } = {},
): RenderResult {
  const { route = "/", recording = null, ...rest } = options;

  function Providers({ children }: { children: ReactNode }) {
    return (
      <I18nextProvider i18n={i18n}>
        <RecordingSessionProvider value={recording}>
          <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
        </RecordingSessionProvider>
      </I18nextProvider>
    );
  }

  return render(ui, { wrapper: Providers, ...rest });
}

/** Forces a known language, so assertions can name the strings they expect. */
export async function useLanguage(language: "en" | "de"): Promise<void> {
  await i18n.changeLanguage(language);
}

/**
 * A recording session at rest, for screens that render one but are not about recording.
 *
 * The session is app-level state now, so a screen under test is given one rather than having the
 * hook that produces it replaced: the stub is the same shape every consumer sees, and a test that
 * cares about a particular phase says so by overriding it.
 */
export function stubRecordingSession(
  overrides: Partial<Omit<RecordingSession, "state">> & { state?: Partial<RecordingState> } = {},
): RecordingSession {
  const { state, ...rest } = overrides;
  return {
    state: {
      phase: "idle",
      elapsedSeconds: 0,
      level: 0,
      silent: false,
      status: null,
      error: null,
      wakeLockSupported: true,
      wakeLockActive: false,
      storageLow: false,
      inputFallback: false,
      mode: "in-person",
      displayEnded: false,
      meetingId: null,
      recoverable: null,
      limit: null,
      ...state,
    },
    start: async () => undefined,
    pause: () => undefined,
    resume: async () => undefined,
    stop: () => undefined,
    reset: () => undefined,
    recover: async () => undefined,
    discardRecoverable: async () => undefined,
    ...rest,
  };
}
