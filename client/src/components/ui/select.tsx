import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The native `select`, restyled to match `Input`.
 *
 * COMPONENTS.md §8 allows a popover select on mobile; the native control gets there without a
 * third dependency and brings the platform's own picker on touch devices, which is the better
 * interaction on a phone anyway. If a richer select is ever needed — grouping, icons, search —
 * that is the moment to bring in the library, not before.
 */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "flex h-11 w-full appearance-none rounded-sm border border-input bg-background px-3 py-2 pr-9 text-base transition-colors duration-micro ease-enter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  ),
);
Select.displayName = "Select";

export { Select };
