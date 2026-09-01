import * as React from "react";
import type { TranscriptionLanguage, UserSettings } from "@quorum/shared";
import { useAuth } from "@/features/auth/auth-provider";
import { MeetingApiError } from "@/features/meetings/api";
import { fetchUserSettings, saveUserSettings } from "@/features/settings/api";

export type UserSettingsStatus = "loading" | "ready" | "error";

export interface UserSettingsState {
  settings: UserSettings;
  status: UserSettingsStatus;
  saving: boolean;
  /** Stores the language new recordings start out in; `null` gives the choice up. */
  chooseTranscriptionLanguage: (language: TranscriptionLanguage | null) => Promise<void>;
}

/** What a user who has chosen nothing has, and what every screen renders until the load lands. */
const UNSET: UserSettings = { transcriptionLanguage: null };

/**
 * The caller's preferences, loaded once.
 *
 * No polling, for the same reason the template list does not poll: these only change when this
 * user changes them. A write replaces the state with what the server answered rather than with
 * what was sent, so the screen shows what is stored and not what was hoped for.
 *
 * A failed load leaves the defaults in place. The recording screen reads this to pre-fill its
 * language indicator, and a preference that could not be read has to degrade into "no preference"
 * — the next link of the chain — rather than into a screen that cannot start a recording.
 */
export function useUserSettings(): UserSettingsState {
  const { accessToken } = useAuth();
  const [settings, setSettings] = React.useState<UserSettings>(UNSET);
  const [status, setStatus] = React.useState<UserSettingsStatus>("loading");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const next = await fetchUserSettings({ accessToken, signal: controller.signal });
        if (!active) return;
        setSettings(next);
        setStatus("ready");
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        // A 401 is not this screen's problem: the shared session-expiry path is already renewing
        // the token or routing into the login flow.
        if (error instanceof MeetingApiError && error.isUnauthorized) return;
        setStatus("error");
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [accessToken]);

  const chooseTranscriptionLanguage = React.useCallback(
    async (language: TranscriptionLanguage | null) => {
      if (!accessToken) throw new MeetingApiError(401, "missing_token", "Not signed in.");
      setSaving(true);
      try {
        const next = await saveUserSettings({ transcriptionLanguage: language }, { accessToken });
        setSettings(next);
        setStatus("ready");
      } finally {
        setSaving(false);
      }
    },
    [accessToken],
  );

  return { settings, status, saving, chooseTranscriptionLanguage };
}
