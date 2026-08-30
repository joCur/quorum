import { AppShell } from "@quorum/client";

/**
 * The shell owns its page content through the router outlet, so an authored preview can only
 * show the frame itself: sidebar with the record action and the destination rail above `md`,
 * bottom tab bar with the raised record button below it.
 */
export function ShellFrame() {
  return <AppShell />;
}
