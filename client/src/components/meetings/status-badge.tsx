import { AlertTriangle, Check, Clock, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MeetingStatus } from "@quorum/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StatusStyle {
  variant: NonNullable<BadgeProps["variant"]>;
  icon: LucideIcon | null;
  /** Spinning icon for the stages that are actively running. */
  spin?: boolean;
}

const STATUS_STYLES: Record<MeetingStatus, StatusStyle> = {
  recording: { variant: "recording", icon: null },
  queued: { variant: "info", icon: Clock },
  transcribing: { variant: "info", icon: Loader2, spin: true },
  summarizing: { variant: "info", icon: Loader2, spin: true },
  ready: { variant: "success", icon: Check },
  failed: { variant: "destructive", icon: AlertTriangle },
};

/**
 * The meeting state as icon + label + color, never color alone (STATES.md §8).
 *
 * `recording` carries the breathing dot instead of an icon — the same signal the recording
 * screen uses, so "this is live" reads identically wherever it appears.
 */
export function StatusBadge({ status, className }: { status: MeetingStatus; className?: string }) {
  const { t } = useTranslation();
  const style = STATUS_STYLES[status];
  const Icon = style.icon;

  return (
    <Badge variant={style.variant} className={cn("animate-pop-in", className)}>
      {Icon ? (
        <Icon
          aria-hidden="true"
          className={cn(style.spin && "animate-spin motion-reduce:animate-none")}
        />
      ) : (
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-recording animate-recording-pulse motion-reduce:animate-none"
        />
      )}
      {t(`meetings.status.${status}`)}
    </Badge>
  );
}
