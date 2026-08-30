import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Pill badge on the status tokens. Every variant pairs a subtle fill with its own foreground, so
 * a state is legible without relying on hue alone — the icon and the label carry it too
 * (STATES.md §8).
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "bg-muted text-muted-foreground",
        info: "bg-info-subtle text-info",
        success: "bg-success-subtle text-success",
        warning: "bg-warning-subtle text-warning",
        destructive: "bg-destructive/10 text-destructive",
        recording: "bg-recording-subtle text-recording",
        // Expressive, not status: plum is the identity color of summaries and
        // templates (DESIGN-SYSTEM.md), which is exactly what "your summaries
        // come out of this one" is saying.
        plum: "bg-plum-subtle text-plum",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
