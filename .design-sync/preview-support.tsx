// Preview-only provider for the design-system sync: initializes the i18n
// catalog (side effect of the import) and provides a router context so
// navigation-aware components render outside the app shell.
import "../client/src/i18n";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

export function DsPreviewProvider({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}
