import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppUpdate } from "@/features/pwa/use-app-update";
import { Button } from "@/components/ui/button";

/**
 * The one in-app prompt a pending update gets.
 *
 * Deliberately a strip and not a toast or a dialog: a toast confirms something the user just did
 * (see `lib/toast`), and a dialog would interrupt a screen to report something nobody asked for.
 * Nothing here blocks — an update the user ignores still arrives on the next launch.
 *
 * While a recording is running the strip stays, but the button does not: the offer would be a
 * trap, because taking it costs the audio still in the buffer.
 */
export function AppUpdateBanner() {
  const { t } = useTranslation();
  const { available, blocked, apply } = useAppUpdate();

  if (!available) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-50 flex animate-rise-in flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-border bg-surface-raised px-4 py-2 text-sm text-foreground shadow-lg"
    >
      <span className="flex items-center gap-2">
        <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
        {blocked ? t("update.blocked") : t("update.available")}
      </span>
      {!blocked && (
        <Button size="sm" variant="secondary" onClick={apply}>
          {t("update.action")}
        </Button>
      )}
    </div>
  );
}
