import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The class-merge helper, taught the theme's own named scales.
 *
 * `twMerge` settles conflicts by knowing which utilities belong to the same group, and it only
 * knows the ones Tailwind ships with. This theme adds named steps of its own — `rounded-pill`,
 * `rounded-card`, `h-top-bar` — which without this look like unrelated classes: handing
 * `rounded-pill` to a component whose base class is `rounded-sm` would leave both in the output
 * and let stylesheet order, rather than the caller, decide the shape. Declaring them here makes
 * the last class win, which is the entire point of a component accepting a `className`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      rounded: [{ rounded: ["pill", "card", "card-sm", "card-lg", "field", "field-sm"] }],
      w: [{ w: ["top-bar", "player-bar"] }],
      h: [{ h: ["top-bar", "player-bar"] }],
    },
  },
});

/** Standard shadcn/ui class merge helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
