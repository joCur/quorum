import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The empty-state visual: one large Lucide icon in a soft rounded container
 * (design system §6). No illustrations, no characters — warmth comes from
 * color, radius and typography.
 */
export function IconTile({
  icon: Icon,
  accent = "honey",
  size = "lg",
  className,
}: {
  icon: LucideIcon;
  accent?: "honey" | "plum";
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        size === "lg" ? "size-24" : "size-14",
        // v2 has one expressive accent, so both branches render honey. The icon
        // uses the strong honey to stay readable on the subtle tint. The
        // empty-state area ticket collapses the `accent` prop away entirely.
        accent === "honey" ? "bg-honey-subtle text-honey-strong" : "bg-plum-subtle text-plum",
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-12" : "size-7"} strokeWidth={1.75} />
    </div>
  );
}
