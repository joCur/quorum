import { UploadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";
import { roundSeconds } from "@/lib/duration";
import { cn } from "@/lib/utils";
import { useTransientStatus } from "@/hooks/use-transient-status";
import type { RecordingClientStatus } from "@/features/recording/protocol-client";

/**
 * The line under the timer, for the states that are worth a sentence.
 *
 * When everything is on its way as it should be, this surface says nothing at
 * all: the breathing indicator and the running timer already confirm the
 * recording is alive, and a standing "Synced" would be text a user can do
 * nothing with. Only states that inform a decision appear — audio still waiting
 * on the device, and a connection that is not carrying it away.
 *
 * Silent does not mean twitchy either. With one-second chunks a healthy
 * connection has something in flight for a fraction of every second, so the
 * message has to hold for a moment before it appears, and stays long enough to
 * read once it has. A connection that is genuinely struggling keeps the
 * condition true, so the message appears and stays.
 */
export function SyncStatus({ status }: { status: RecordingClientStatus | null }) {
  const { t } = useTranslation();

  const degraded = status !== null && status.connection !== "open";
  const syncing = status !== null && (status.pendingChunks > 0 || degraded);
  const { visible, value: seconds } = useTransientStatus(
    syncing,
    roundSeconds(status?.pendingSeconds ?? 0),
  );

  const message = degraded
    ? t("recording.sync.unstable", { seconds })
    : t("recording.sync.saving", { seconds });

  return (
    <>
      {/* The live region stays mounted so a state change is announced, rather
          than lost together with the element that carried it. */}
      <span className="sr-only" aria-live="polite">
        {visible ? message : ""}
      </span>
      {visible ? (
        <p
          aria-hidden="true"
          className={cn(
            "flex animate-rise-in items-center gap-1.5 text-sm transition-colors ease-enter",
            degraded ? "text-warning" : "text-muted-foreground",
          )}
        >
          <UploadCloud className="size-4" aria-hidden="true" />
          {message}
        </p>
      ) : null}
    </>
  );
}
