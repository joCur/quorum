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
        accent === "honey" ? "bg-honey-subtle text-honey" : "bg-plum-subtle text-plum",
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-12" : "size-7"} strokeWidth={1.75} />
    </div>
  );
}
