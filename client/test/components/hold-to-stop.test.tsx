import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { HOLD_DURATION_MS, HoldToStopButton } from "@/components/recording/hold-to-stop-button";
import { renderWithProviders, useLanguage } from "./render";

/**
 * Stopping is a press-and-hold now, and the stop-confirm dialog is gone. The confirmation existed
 * to prevent pocket-stops; the hold has to take that job over completely, which makes "a short
 * press does nothing" as important a guarantee here as "a full hold stops".
 *
 * The clock is faked so the 1.2s is asserted as a duration rather than waited out, and so a
 * release one tick short of the end is expressible at all.
 */

const reducedMotion = vi.hoisted(() => ({ current: false }));

vi.mock("@/hooks/use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: () => reducedMotion.current,
}));

function ring() {
  return screen.getByTestId("hold-to-stop");
}

function hint() {
  return screen.getByTestId("hold-to-stop-hint").textContent;
}

/** The filled sweep of the conic gradient, in degrees — what the user sees of their progress. */
function filledDegrees(): number {
  const match = /(\d+)deg/.exec(ring().style.background);
  return match === null ? 0 : Number(match[1]);
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("hold to stop", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    reducedMotion.current = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing on a press that is released early", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.pointerDown(ring());
    advance(HOLD_DURATION_MS - 100);
    expect(onStop).not.toHaveBeenCalled();

    fireEvent.pointerUp(ring());
    // Not merely "not yet": releasing early is a cancellation, so the remaining time must not
    // arrive later and stop the recording behind the user's back.
    advance(HOLD_DURATION_MS * 2);
    expect(onStop).not.toHaveBeenCalled();
    expect(filledDegrees()).toBe(0);
    expect(hint()).toBe("Hold to stop");
  });

  it("stops once the hold completes", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.pointerDown(ring());
    advance(HOLD_DURATION_MS);

    expect(onStop).toHaveBeenCalledTimes(1);
    // The ring empties on completion rather than staying full: the button's next state is the
    // finalizing screen, not a stop that looks like it is still pending.
    expect(filledDegrees()).toBe(0);
  });

  it("fills the ring as the hold runs and says so", () => {
    renderWithProviders(<HoldToStopButton active onStop={vi.fn()} />);

    expect(filledDegrees()).toBe(0);
    fireEvent.pointerDown(ring());
    advance(HOLD_DURATION_MS / 2);

    // Halfway through the hold is halfway around the ring — the ring tracks the finger, which is
    // the whole reason it is allowed to move at all.
    expect(filledDegrees()).toBeGreaterThan(150);
    expect(filledDegrees()).toBeLessThan(210);
    expect(hint()).toBe("Keep holding…");
  });

  it("treats a finger leaving the button as a release", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.pointerDown(ring());
    advance(600);
    fireEvent.pointerLeave(ring());
    advance(HOLD_DURATION_MS);

    expect(onStop).not.toHaveBeenCalled();
    expect(filledDegrees()).toBe(0);
  });

  it("cancels when the system takes the pointer away", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.pointerDown(ring());
    advance(600);
    fireEvent.pointerCancel(ring());
    advance(HOLD_DURATION_MS);

    expect(onStop).not.toHaveBeenCalled();
  });

  it("is the same hold from the keyboard", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    // Holding Enter is the identical gesture with the identical timing, so keyboard users learn
    // one interaction rather than a parallel one.
    fireEvent.keyDown(ring(), { key: "Enter" });
    advance(HOLD_DURATION_MS - 100);
    expect(onStop).not.toHaveBeenCalled();
    advance(100);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("releases the keyboard hold when the key comes up", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.keyDown(ring(), { key: " " });
    advance(600);
    fireEvent.keyUp(ring(), { key: " " });
    advance(HOLD_DURATION_MS);

    expect(onStop).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat so a held key does not restart its own hold", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.keyDown(ring(), { key: "Enter" });
    advance(600);
    // The OS repeats keydown while the key is down; a naive handler would reset the timer on each
    // repeat and the hold could never complete.
    fireEvent.keyDown(ring(), { key: "Enter", repeat: true });
    advance(600);

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores the click a real press leaves behind", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.pointerDown(ring());
    advance(200);
    fireEvent.pointerUp(ring());
    fireEvent.click(ring(), { detail: 1 });

    // A short press must be inert. If its trailing click armed the button, the gesture would be
    // one stray tap away from stopping the recording — exactly what the hold prevents.
    expect(onStop).not.toHaveBeenCalled();
    expect(hint()).toBe("Hold to stop");
  });

  it("degrades to a delayed confirm for a synthesized activation", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    // Assistive technology activates a button without a pointer or key sequence behind it, so the
    // gesture is not available at all. Two deliberate activations carry the same protection.
    fireEvent.click(ring(), { detail: 0 });
    expect(onStop).not.toHaveBeenCalled();
    expect(hint()).toBe("Press again to stop the recording");

    fireEvent.click(ring(), { detail: 0 });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("forgets an arming that is left alone", () => {
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.click(ring(), { detail: 0 });
    advance(6000);
    expect(hint()).toBe("Hold to stop");

    // The window has closed, so this is a first activation again rather than the confirming one.
    fireEvent.click(ring(), { detail: 0 });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("still renders the ring with reduced motion, in steps rather than a sweep", () => {
    reducedMotion.current = true;
    const onStop = vi.fn();
    renderWithProviders(<HoldToStopButton active onStop={onStop} />);

    fireEvent.pointerDown(ring());
    advance(HOLD_DURATION_MS / 2);

    // The ring is interaction motion and has to stay legible — a hold with no feedback reads as a
    // broken button. It advances in whole quarters instead of gliding, and the hint carries the
    // rest.
    expect(filledDegrees()).toBe(180);
    expect(hint()).toBe("Keep holding…");

    advance(HOLD_DURATION_MS / 2);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("drops the red while capture is paused, keeping the same control", () => {
    const onStop = vi.fn();
    const { rerender } = renderWithProviders(<HoldToStopButton active={false} onStop={onStop} />);

    // Red is reserved for live capture: a red control on a paused screen would be the "am I still
    // being recorded?" ambiguity the rule exists to prevent.
    expect(ring().style.background).not.toContain("--recording");
    // Same control, same gesture — only the color follows capture.
    fireEvent.pointerDown(ring());
    advance(HOLD_DURATION_MS);
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(<HoldToStopButton active onStop={onStop} />);
    expect(ring().style.background).toContain("--recording");
  });

  it("names the interaction in its accessible name and its description", () => {
    renderWithProviders(<HoldToStopButton active onStop={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Stop recording — press and hold" });
    expect(button).toHaveAccessibleDescription("Hold to stop");
  });
});
