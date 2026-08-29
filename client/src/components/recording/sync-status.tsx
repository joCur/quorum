import { Check, UploadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";
import { roundSeconds } from "@/lib/duration";
import { cn } from "@/lib/utils";
import { useTransientStatus } from "@/hooks/use-transient-status";
import type { RecordingClientStatus } from "@/features/recording/protocol-client";

/**
 * The honest line under the timer: what is on the server, and what is still only
 * on this device. Driven entirely by `chunk.ack`/`persistedSeq` — it never
 * claims more than the server has confirmed.
 *
 * Honest does not mean twitchy. With one-second chunks a healthy connection has
 * something in flight for a fraction of every second, and rendering that
 * directly gives a line that flashes without ever being readable. The syncing
 * message therefore has to hold for a moment before it appears, and once it has
 * appeared it stays long enough to read. Nothing that matters is hidden: a
 * connection that is genuinely struggling keeps the condition true, so the
 * message appears and stays.
 */
export function SyncStatus({ status }: { status: RecordingClientStatus | null }) {
  const { t } = useTranslation();

  const degraded = status !== null && status.connection !== "open";
  const syncing = status !== null && (status.pendingChunks > 0 || degraded);
  const { visible, value: seconds } = useTransientStatus(
    syncing,
    roundSeconds(status?.pendingSeconds ?? 0),
  );

  if (!status) return null;

  return (
    <p
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 text-sm transition-colors ease-enter",
        visible && degraded ? "text-warning" : "text-muted-foreground",
      )}
    >
      {visible ? (
        <>
          <UploadCloud className="size-4" aria-hidden="true" />
          {degraded
            ? t("recording.sync.unstable", { seconds })
            : t("recording.sync.saving", { seconds })}
        </>
      ) : (
        <>
          <Check className="size-4" aria-hidden="true" />
          {t("recording.sync.synced")}
        </>
      )}
    </p>
  );
}
