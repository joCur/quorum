import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSIENT_VISIBILITY, TransientVisibility } from "../src/lib/transient-visibility";
import {
  ATTACK_MS,
  LEVEL_EPSILON,
  RELEASE_MS,
  followEnvelope,
  normalizeRms,
} from "../src/lib/level-envelope";
import { TransientStatusStore } from "../src/lib/transient-status-store";

describe("transient visibility", () => {
  it("never shows a state that resolves within the appear delay", () => {
    const gate = new TransientVisibility();
    // The exact defect: with one-second chunks the sync state is true only
    // briefly on every round trip, and it must never reach the screen.
    let visible = false;
    for (let second = 0; second < 10; second += 1) {
      const base = second * 1000;
      visible ||= gate.update(true, base);
      visible ||= gate.update(true, base + 120);
      visible ||= gate.update(false, base + 150);
    }
    expect(visible).toBe(false);
  });

  it("shows a state that outlasts the appear delay", () => {
    const gate = new TransientVisibility();
    expect(gate.update(true, 0)).toBe(false);
    expect(gate.update(true, DEFAULT_TRANSIENT_VISIBILITY.appearAfterMs - 1)).toBe(false);
    expect(gate.update(true, DEFAULT_TRANSIENT_VISIBILITY.appearAfterMs)).toBe(true);
  });

  it("keeps a shown message up long enough to read", () => {
    const gate = new TransientVisibility();
    gate.update(true, 0);
    gate.update(true, 300);
    expect(gate.visible).toBe(true);

    // Resolved immediately after appearing — the message still has to stay.
    expect(gate.update(false, 310)).toBe(true);
    expect(gate.update(false, 300 + DEFAULT_TRANSIENT_VISIBILITY.minVisibleMs - 1)).toBe(true);
    expect(gate.update(false, 300 + DEFAULT_TRANSIENT_VISIBILITY.minVisibleMs)).toBe(false);
  });

  it("reports when the answer changes without further input", () => {
    const gate = new TransientVisibility();
    gate.update(true, 1_000);
    expect(gate.nextTransitionAt()).toBe(1_000 + DEFAULT_TRANSIENT_VISIBILITY.appearAfterMs);

    gate.update(true, 1_300);
    expect(gate.nextTransitionAt()).toBeNull();

    gate.update(false, 1_400);
    expect(gate.nextTransitionAt()).toBe(1_300 + DEFAULT_TRANSIENT_VISIBILITY.minVisibleMs);
  });

  it("does not restart the appear delay while the state simply continues", () => {
    const gate = new TransientVisibility();
    gate.update(true, 0);
    gate.update(true, 100);
    gate.update(true, 200);
    expect(gate.update(true, 300)).toBe(true);
  });
});

describe("level envelope", () => {
  it("rises faster than it falls", () => {
    const rising = followEnvelope(0, 1, 50);
    const falling = 1 - followEnvelope(1, 0, 50);
    expect(rising).toBeGreaterThan(falling);
  });

  it("is independent of the frame rate", () => {
    // One 32 ms step must land where two 16 ms steps land.
    const coarse = followEnvelope(0, 1, 32);
    const fine = followEnvelope(followEnvelope(0, 1, 16), 1, 16);
    expect(coarse).toBeCloseTo(fine, 6);
  });

  it("approaches the target without overshooting it", () => {
    let level = 0;
    for (let step = 0; step < 200; step += 1) level = followEnvelope(level, 0.8, 16);
    expect(level).toBeGreaterThan(0.79);
    expect(level).toBeLessThanOrEqual(0.8);
  });

  it("smooths a jittery signal into steps too small to read as flicker", () => {
    // Speech-like input: alternating loud and near-silent frames, the pattern
    // that made the raw indicator strobe.
    let level = 0;
    let previous = 0;
    let largestStep = 0;
    for (let frame = 0; frame < 300; frame += 1) {
      const raw = frame % 2 === 0 ? 0.9 : 0.05;
      level = followEnvelope(level, raw, 16);
      largestStep = Math.max(largestStep, Math.abs(level - previous));
      previous = level;
    }
    // At or under the ±10% the indicator maps the level onto: even the worst
    // single frame cannot make the dot visibly jump.
    expect(largestStep).toBeLessThanOrEqual(0.1);
  });

  it("settles rather than oscillating once speech stops", () => {
    let level = 0;
    for (let frame = 0; frame < 60; frame += 1) level = followEnvelope(level, 0.9, 16);
    const steps: number[] = [];
    let previous = level;
    // Three seconds of silence — the release is deliberately unhurried.
    for (let frame = 0; frame < 180; frame += 1) {
      level = followEnvelope(level, 0, 16);
      steps.push(Math.abs(level - previous));
      previous = level;
    }
    expect(level).toBeLessThan(LEVEL_EPSILON);
    // Monotone decay: each step is smaller than the one before it.
    expect(steps.every((step, index) => index === 0 || step <= steps[index - 1]!)).toBe(true);
  });

  it("uses attack and release constants that differ by a wide margin", () => {
    expect(RELEASE_MS).toBeGreaterThan(ATTACK_MS * 3);
  });

  it("maps rms into the unit range", () => {
    expect(normalizeRms(0)).toBe(0);
    expect(normalizeRms(1)).toBe(1);
    expect(normalizeRms(0.04)).toBeCloseTo(0.6, 5);
  });
});

describe("transient status store", () => {
  it("does not surface the once-per-second sync blip", () => {
    const store = new TransientStatusStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    for (let round = 0; round < 5; round += 1) {
      store.update(true, 1);
      store.update(false, 0);
    }

    expect(store.getSnapshot().visible).toBe(false);
    expect(notifications).toBe(0);
    store.dispose();
  });

  it("holds the counter at its last active reading while fading out", async () => {
    const store = new TransientStatusStore({ appearAfterMs: 0, minVisibleMs: 10_000 });
    store.update(true, 14);
    expect(store.getSnapshot()).toEqual({ visible: true, value: 14 });

    // Everything acknowledged: the message stays and keeps its last number
    // rather than blinking to zero on the way out.
    store.update(false, 0);
    expect(store.getSnapshot()).toEqual({ visible: true, value: 14 });
    store.dispose();
  });

  it("keeps the snapshot referentially stable when nothing changed", () => {
    const store = new TransientStatusStore({ appearAfterMs: 0, minVisibleMs: 1_000 });
    store.update(true, 3);
    const first = store.getSnapshot();
    store.update(true, 3);
    expect(store.getSnapshot()).toBe(first);
    store.dispose();
  });

  it("becomes visible on its own once the appear delay passes", async () => {
    const store = new TransientStatusStore({ appearAfterMs: 20, minVisibleMs: 50 });
    store.update(true, 7);
    expect(store.getSnapshot().visible).toBe(false);

    // No further input — the armed timer is what flips it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(store.getSnapshot().visible).toBe(true);
    store.dispose();
  });
});
