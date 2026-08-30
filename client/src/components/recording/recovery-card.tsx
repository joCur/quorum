import { CloudOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRecordingSession } from "@/features/recording/recording-context";

/**
 * Shown when a previous recording never reached `session.finalized` — a closed
 * tab, a crash, or a stop while offline. The audio is still in the local buffer,
 * so it can simply be delivered. Factual tone, no reassurance the data does not
 * support.
 */
export function RecoveryCard() {
  const { t } = useTranslation();
  const recording = useRecordingSession();
  const session = recording?.state.recoverable ?? null;
  if (!recording || !session) return null;

  const { state, recover, discardRecoverable } = recording;
  // A running recording is unfinished audio too, and the card must not offer to take it over:
  // recovering replaces the protocol client, so the offer stands down until the session is done.
  if (state.phase === "recording" || state.phase === "paused") return null;

  const busy = state.phase === "finalizing";

  return (
    <Card className="animate-rise-in border-warning/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudOff className="size-5 text-warning" aria-hidden="true" />
          {t("recording.recovery.title")}
        </CardTitle>
        <CardDescription>
          {t("recording.recovery.body", {
            date: new Date(session.startedAt).toLocaleString(),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void recover(session)}>
          {t("recording.recovery.upload")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void discardRecoverable(session)}
        >
          {t("recording.recovery.discard")}
        </Button>
      </CardContent>
    </Card>
  );
}
