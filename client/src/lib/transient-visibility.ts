/**
 * Keeps short-lived status messages readable.
 *
 * With one-second chunks the sync state flips between "everything is on the
 * server" and "something is in flight" roughly once per second, and rendering
 * that directly produces a line that flashes without ever being readable. Two
 * rules fix it, and both are needed:
 *
 * - a state must persist for `appearAfterMs` before it is shown at all, so the
 *   ordinary one-chunk round trip never surfaces;
 * - once shown it stays for at least `minVisibleMs`, so a message that does
 *   appear can actually be read.
 *
 * Kept free of React so the timing rules can be tested directly.
 */

export interface TransientVisibilityOptions {
  /** How long the condition must hold before the message appears. */
  appearAfterMs: number;
  /** How long a message stays once it has appeared. */
  minVisibleMs: number;
}

export const DEFAULT_TRANSIENT_VISIBILITY: TransientVisibilityOptions = {
  appearAfterMs: 300,
  minVisibleMs: 1_800,
};

export class TransientVisibility {
  private readonly options: TransientVisibilityOptions;
  private activeSince: number | null = null;
  private visibleSince: number | null = null;

  constructor(options: TransientVisibilityOptions = DEFAULT_TRANSIENT_VISIBILITY) {
    this.options = options;
  }

  get visible(): boolean {
    return this.visibleSince !== null;
  }

  /** Feeds the current condition in and returns whether the message is shown. */
  update(active: boolean, now: number): boolean {
    if (active) {
      this.activeSince ??= now;
      if (this.visibleSince === null && now - this.activeSince >= this.options.appearAfterMs) {
        this.visibleSince = now;
      }
    } else {
      this.activeSince = null;
      if (this.visibleSince !== null && now - this.visibleSince >= this.options.minVisibleMs) {
        this.visibleSince = null;
      }
    }
    return this.visible;
  }

  /**
   * When the result would change on its own, with no further input — the moment
   * a caller has to schedule a timer for. Null when nothing is pending.
   */
  nextTransitionAt(): number | null {
    if (this.activeSince !== null && this.visibleSince === null) {
      return this.activeSince + this.options.appearAfterMs;
    }
    if (this.activeSince === null && this.visibleSince !== null) {
      return this.visibleSince + this.options.minVisibleMs;
    }
    return null;
  }
}
