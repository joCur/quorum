import { Toaster as Sonner } from "sonner";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useTheme } from "@/features/theme/theme-provider";

/** How long a confirmation stays on screen. Long enough to read, short enough not to nag. */
const TOAST_DURATION_MS = 4000;

/**
 * Toast host, themed with the design tokens.
 *
 * Sonner ships its own light and dark styling, which would sit next to the token palette rather
 * than inside it. Every surface here is therefore expressed in the semantic classes generated
 * from `tokens.css`, so a toast is the same warm popover the rest of the app uses and follows the
 * color scheme automatically. `theme` is still passed through for the parts of the library that
 * are not covered by these classes.
 *
 * Mounted once, at the application root: the recording screen renders outside the app shell, and
 * a confirmation must survive the navigation that often follows the action it confirms.
 */
export function Toaster() {
  const { resolved } = useTheme();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <Sonner
      theme={resolved}
      position="bottom-center"
      duration={TOAST_DURATION_MS}
      // A confirmation is not an alert: it must never take the pointer or the focus away from
      // whatever the user does next.
      toastOptions={{
        classNames: {
          // Sonner injects its own stylesheet at runtime, after Tailwind's, and its rules match
          // on the same specificity. The token colors are marked important so the surface stays
          // ours regardless of which stylesheet lands last.
          toast: [
            "flex w-full items-center gap-3 px-4 py-3 font-sans text-sm",
            "!rounded-md !border !border-border !bg-popover !text-popover-foreground !shadow-lg",
            // Sonner animates entry and exit with its own transitions. With reduced motion the
            // toast simply appears — the message carries the information, never the movement.
            reducedMotion ? "!transition-none !animate-none" : "",
          ]
            .filter(Boolean)
            .join(" "),
          title: "font-medium",
          description: "text-muted-foreground",
          icon: "shrink-0",
          success: "[&_[data-icon]]:text-success",
          error: "[&_[data-icon]]:text-destructive",
          actionButton: "rounded-sm bg-primary px-2 py-1 text-primary-foreground",
          cancelButton: "rounded-sm bg-muted px-2 py-1 text-muted-foreground",
          closeButton: "border-border bg-popover text-muted-foreground",
        },
      }}
      // Clear of the mobile tab bar and the meeting detail's playback bar, both of which own the
      // bottom edge of a small screen.
      mobileOffset={{ bottom: "5.5rem" }}
    />
  );
}
