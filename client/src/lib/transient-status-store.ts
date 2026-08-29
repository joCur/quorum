import {
  DEFAULT_TRANSIENT_VISIBILITY,
  TransientVisibility,
  type TransientVisibilityOptions,
} from "@/lib/transient-visibility";

/**
 * Subscribable view of a `TransientVisibility` gate.
 *
 * The gate is time-driven: its answer changes on its own when a delay elapses,
 * with no new input. That makes it an external source of truth rather than
 * derived render state, so it is exposed as a store and read through
 * `useSyncExternalStore` — the component never has to mutate anything during
 * render or chain state updates through effects.
 *
 * It also carries the number shown alongside the message, frozen while the
 * message is on its way out so the last thing the eye catches is not a counter
 * dropping to zero.
 */
export interface TransientStatusSnapshot {
  visible: boolean;
  /** Value to display; held at its last active reading while fading out. */
  value: number;
}

type Listener = () => void;

export class TransientStatusStore {
  private readonly gate: TransientVisibility;
  private readonly listeners = new Set<Listener>();
  private snapshot: TransientStatusSnapshot = { visible: false, value: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TransientVisibilityOptions = DEFAULT_TRANSIENT_VISIBILITY) {
    this.gate = new TransientVisibility(options);
  }

  /** Feeds the current condition in. Safe to call on every render pass. */
  update = (active: boolean, value: number): void => {
    const visible = this.gate.update(active, Date.now());
    // While nothing is on screen the value is not worth tracking: publishing it
    // would wake every subscriber once a second for a message nobody can see.
    // While fading out the last active reading is held, so the number does not
    // blink to zero on the way off screen.
    const next = visible ? (active ? value : this.snapshot.value) : this.snapshot.value;
    this.publish(visible, next);
    this.arm(active, value);
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TransientStatusSnapshot => this.snapshot;

  dispose = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  };

  /** Wakes the store at the moment the gate's answer changes by itself. */
  private arm(active: boolean, value: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const nextAt = this.gate.nextTransitionAt();
    if (nextAt === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.update(active, value);
      },
      Math.max(0, nextAt - Date.now()),
    );
  }

  private publish(visible: boolean, value: number): void {
    if (this.snapshot.visible === visible && this.snapshot.value === value) return;
    // A new object only when something actually changed, so subscribers are not
    // woken for identical snapshots.
    this.snapshot = { visible, value };
    for (const listener of this.listeners) listener();
  }
}
