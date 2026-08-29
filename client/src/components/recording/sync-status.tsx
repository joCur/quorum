import { Check, UploadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";
import { roundSeconds } from "@/lib/duration";
import type { RecordingClientStatus } from "@/features/recording/protocol-client";

/**
 * The honest line under the timer: what is on the server, and what is still only
 * on this device. Driven entirely by `chunk.ack`/`persistedSeq` — it never
 * claims more than the server has confirmed.
 */
export function SyncStatus({ status }: { status: RecordingClientStatus | null }) {
  const { t } = useTranslation();
  if (!status) return null;

  const buffered = roundSeconds(status.pendingSeconds);
  const degraded = status.connection !== "open";

  if (status.pendingChunks === 0 && !degraded) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Check className="size-4" aria-hidden="true" />
        {t("recording.sync.synced")}
      </p>
    );
  }

  return (
    <p
      aria-live="polite"
      className={`flex items-center gap-1.5 text-sm ${degraded ? "text-warning" : "text-muted-foreground"}`}
    >
      <UploadCloud className="size-4" aria-hidden="true" />
      {degraded
        ? t("recording.sync.unstable", { seconds: buffered })
        : t("recording.sync.saving", { seconds: buffered })}
    </p>
  );
}
