/**
 * Envelope follower for the microphone level.
 *
 * Raw RMS jumps between frames, and feeding it straight into the UI makes the
 * recording indicator strobe rather than breathe. Smoothing it with a fast
 * attack and a slow release gives a signal that rises promptly when someone
 * starts speaking and falls back calmly — the way a level meter is expected to
 * behave, and the same signal both the meter and the indicator read from.
 *
 * The coefficient is derived from elapsed time rather than a fixed per-frame
 * value, so the result does not change with the display's refresh rate.
 */

/**
 * Time constant for a rising level. Fast enough that the meter answers a voice
 * immediately (roughly 95% of the way there within 450 ms), slow enough that a
 * single loud analysis frame can never move the level more than about a tenth
 * of the scale — which is the whole range the recording indicator maps onto, so
 * one loud frame can never make the dot jump.
 */
export const ATTACK_MS = 150;

/** Time constant for a falling level — slow, so the indicator never flickers. */
export const RELEASE_MS = 500;

/**
 * Smallest change worth publishing to React. Below this the movement is
 * invisible and only costs a re-render.
 */
export const LEVEL_EPSILON = 0.015;

export function followEnvelope(
  previous: number,
  target: number,
  deltaMs: number,
  attackMs: number = ATTACK_MS,
  releaseMs: number = RELEASE_MS,
): number {
  if (deltaMs <= 0) return previous;
  const timeConstant = target > previous ? attackMs : releaseMs;
  const alpha = 1 - Math.exp(-deltaMs / timeConstant);
  return previous + (target - previous) * alpha;
}

export function normalizeRms(rms: number): number {
  // Square root curve: ordinary speech then uses most of the range instead of
  // hugging the bottom of the scale.
  return Math.min(1, Math.max(0, Math.sqrt(rms) * 3));
}
