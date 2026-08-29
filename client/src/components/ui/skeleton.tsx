import { cn } from "@/lib/utils";

/**
 * Loading placeholder. Skeletons mirror the geometry of the content they stand in for, so the
 * layout does not jump when the real thing arrives.
 *
 * The shimmer is decorative: `aria-hidden`, and it stops entirely under reduced motion, where a
 * flat block is the honest rendering of "not here yet".
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-sm bg-muted",
        "bg-[linear-gradient(90deg,transparent,hsl(var(--foreground)/0.06),transparent)] bg-[length:200%_100%] animate-shimmer",
        "motion-reduce:animate-none motion-reduce:bg-none",
        className,
      )}
      {...props}
    />
  );
}
