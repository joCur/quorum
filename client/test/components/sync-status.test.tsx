import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RecordingClientStatus } from "@/features/recording/protocol-client";
import { SyncStatus } from "@/components/recording/sync-status";
import { DEFAULT_TRANSIENT_VISIBILITY } from "@/lib/transient-visibility";
import { renderWithProviders, useLanguage } from "./render";

const { appearAfterMs, minVisibleMs } = DEFAULT_TRANSIENT_VISIBILITY;

function status(overrides: Partial<RecordingClientStatus> = {}): RecordingClientStatus {
  return {
    connection: "open",
    sessionId: "11111111-2222-4333-8444-555555555555",
    lastSeq: 4,
    persistedSeq: 4,
    pendingChunks: 0,
    pendingSeconds: 0,
    finalized: false,
    ...overrides,
  };
}

/** Advances both the clock the gate reads and the timers it arms. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * The sync line under the recording timer.
 *
 * Two rules meet here and both came from watching a real recording: a healthy connection with
 * one-second chunks has something in flight for a fraction of every second, so rendering the raw
 * condition produced a line that flickered without ever being readable — and a genuinely
 * struggling connection has to say so and then hold still long enough to be read.
 */
describe("recording sync status", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  function liveRegion(): HTMLElement {
    const region = document.querySelector<HTMLElement>(".sr-only");
    if (!region) throw new Error("the live region is not mounted");
    return region;
  }

  function shownText(): string | null {
    // The visible line is aria-hidden and the live region carries the same message, so either
    // one is a fair read of "what the user is being told right now".
    const line = document.querySelector("p[aria-hidden='true']");
    return line?.textContent?.trim() ?? null;
  }

  it("says nothing while everything is on its way as it should be", () => {
    renderWithProviders(<SyncStatus status={status()} />);

    // The resting state is silent: the breathing indicator and the running timer already say the
    // recording is alive, and a standing "Synced" is a sentence the user can do nothing with.
    expect(shownText()).toBeNull();
    expect(liveRegion().textContent).toBe("");
  });

  it("stays silent through an ordinary one-chunk round trip", async () => {
    vi.useFakeTimers();
    const { rerender } = renderWithProviders(<SyncStatus status={status({ pendingChunks: 1 })} />);

    // Shorter than the appear delay — the everyday case, and the one that used to flicker.
    await advance(appearAfterMs - 50);
    expect(shownText()).toBeNull();

    rerender(<SyncStatus status={status()} />);
    await advance(1_000);
    expect(shownText()).toBeNull();
  });

  it("speaks up once a state has genuinely persisted", async () => {
    vi.useFakeTimers();
    renderWithProviders(<SyncStatus status={status({ pendingChunks: 3, pendingSeconds: 7 })} />);

    await advance(appearAfterMs + 50);

    expect(shownText()).toContain("Saving your recording");
    // The number is the point of the message: how much audio is still only on this device.
    expect(shownText()).toContain("7");
  });

  it("holds a message on screen long enough to read it", async () => {
    vi.useFakeTimers();
    const { rerender } = renderWithProviders(
      <SyncStatus status={status({ pendingChunks: 3, pendingSeconds: 7 })} />,
    );

    await advance(appearAfterMs + 50);
    expect(shownText()).not.toBeNull();

    // The condition clears immediately after the message appeared. Removing it now would make it
    // a flash the eye registers but cannot read.
    rerender(<SyncStatus status={status()} />);
    await advance(minVisibleMs - 200);
    expect(shownText()).not.toBeNull();

    await advance(400);
    expect(shownText()).toBeNull();
  });

  it("distinguishes a struggling connection from a busy one", async () => {
    vi.useFakeTimers();
    renderWithProviders(
      <SyncStatus status={status({ connection: "reconnecting", pendingSeconds: 12 })} />,
    );

    await advance(appearAfterMs + 50);

    // Not "saving": the recording is being held on the device rather than moving, and the user
    // may want to act on that.
    expect(shownText()).toContain("Connection unstable");
    expect(shownText()).not.toContain("Saving your recording");
  });

  it("keeps the live region mounted so a change is announced", () => {
    const { rerender } = renderWithProviders(<SyncStatus status={status()} />);
    const region = liveRegion();

    rerender(<SyncStatus status={status({ pendingChunks: 2 })} />);

    // The same node, updated — not a node that appears and disappears, which would take the
    // announcement with it.
    expect(liveRegion()).toBe(region);
    expect(region).toHaveAttribute("aria-live", "polite");
  });
});
