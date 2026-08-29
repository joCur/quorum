import * as React from "react";
import { TransientStatusStore, type TransientStatusSnapshot } from "@/lib/transient-status-store";
import type { TransientVisibilityOptions } from "@/lib/transient-visibility";

/**
 * React binding for the transient status gate: tells a component whether a
 * short-lived message should currently be on screen, and which number to show
 * with it.
 */
export function useTransientStatus(
  active: boolean,
  value: number,
  options?: TransientVisibilityOptions,
): TransientStatusSnapshot {
  const [store] = React.useState(() => new TransientStatusStore(options));

  React.useEffect(() => {
    store.update(active, value);
  }, [store, active, value]);

  React.useEffect(() => () => store.dispose(), [store]);

  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
