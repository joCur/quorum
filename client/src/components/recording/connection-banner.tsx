import type { ReactNode } from "react";
import { CloudOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { roundSeconds } from "@/lib/duration";
import type { RecordingClientStatus } from "@/features/recording/protocol-client";

/**
 * App-level condition strip. Losing the network is a warning, never an error:
 * capture continues and the audio is safe locally. Only running out of storage —
 * where audio really could be lost — escalates to a destructive tone.
 */
export function ConnectionBanner({
  status,
  storageLow,
}: {
  status: RecordingClientStatus | null;
  storageLow: boolean;
}) {
  const { t } = useTranslation();
  if (!status) return null;

  const buffered = roundSeconds(status.pendingSeconds);

  if (storageLow) {
    return (
      <Strip tone="destructive" icon={<TriangleAlert className="size-4" aria-hidden="true" />}>
        {t("recording.banner.storage")}
      </Strip>
    );
  }

  if (status.connection === "reconnecting") {
    return (
      <Strip
        tone="warning"
        icon={<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
      >
        {t("recording.banner.reconnecting", { seconds: buffered })}
      </Strip>
    );
  }

  if (status.connection === "connecting" || status.connection === "closed") {
    return (
      <Strip tone="warning" icon={<CloudOff className="size-4" aria-hidden="true" />}>
        {t("recording.banner.offline", { seconds: buffered })}
      </Strip>
    );
  }

  return null;
}

function Strip({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "destructive";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex animate-rise-in items-center justify-center gap-2 px-4 py-2 text-sm",
        tone === "warning"
          ? "bg-warning-subtle text-warning"
          : "bg-destructive/10 text-destructive",
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}
