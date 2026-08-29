import * as React from "react";
import { useAuth } from "@/features/auth/auth-provider";
import { meetingAudioUrl } from "@/features/meetings/api";

export type AudioStatus = "idle" | "loading" | "ready" | "error";

export interface MeetingAudio {
  /** Object URL for the `<audio>` element, or null while it is not available. */
  url: string | null;
  status: AudioStatus;
  reload: () => void;
}

/**
 * Loads a meeting's audio for playback.
 *
 * WHY A BLOB AND NOT `<audio src="/api/…">`: the endpoint requires an access token, and a media
 * element cannot send an `Authorization` header. The alternatives were putting the token in the
 * URL — where it lands in access logs and browser history — or issuing a presigned storage URL,
 * which PR-1's scoping argument already rules out. Fetching with the header and handing the
 * element an object URL keeps the token where it belongs.
 *
 * The cost is that the whole recording is downloaded before playback starts, so this trades the
 * byte-range support the endpoint offers for a token that never leaks. At Opus mono bitrates an
 * hour is roughly 10 MB, which is a fair trade at V1 sizes — and it has an upside: with all the
 * bytes present the browser can seek freely, which a streamed WebM without a cue index otherwise
 * cannot. If recordings get long enough for this to hurt, the fix is a short-lived scoped
 * playback token, not a wider-open URL.
 */
export function useMeetingAudio(meetingId: string, available: boolean): MeetingAudio {
  const { accessToken } = useAuth();
  const [url, setUrl] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<AudioStatus>("idle");
  const [reloadToken, setReloadToken] = React.useState(0);

  // Whether there is anything to load at all. Derived rather than pushed into state: "no audio
  // yet" is a fact about the props, and storing it would give it a second, lagging version.
  const enabled = accessToken !== null && available;

  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let active = true;

    void (async () => {
      setStatus("loading");
      try {
        const response = await fetch(meetingAudioUrl(meetingId), {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`audio request failed with ${response.status}`);
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setStatus("ready");
      } catch {
        if (!active || controller.signal.aborted) return;
        setStatus("error");
      }
    })();

    return () => {
      active = false;
      controller.abort();
      // Object URLs are held by the document until revoked; without this, navigating between
      // meetings would keep every recording listened to in memory for the whole session.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [accessToken, meetingId, enabled, reloadToken]);

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), []);

  return { url, status: enabled ? status : "idle", reload };
}
