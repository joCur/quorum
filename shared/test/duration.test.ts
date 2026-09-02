import { describe, expect, it } from "vitest";
import {
  billableRecordedSeconds,
  DEFAULT_DURATION_TOLERANCE,
  reconcileRecordedDuration,
} from "../src/duration.js";

/** An hour of meeting, in the shape the two numbers arrive in. */
const HOUR = 3600;

describe("reconcileRecordedDuration", () => {
  it("bills the audio's real length once it is known", () => {
    const result = reconcileRecordedDuration({ assertedSeconds: 1800, trueSeconds: 1803.4 });

    expect(result.billableSeconds).toBe(1803.4);
    expect(result.outcome).toBe("within_tolerance");
  });

  it("tolerates the drift an honest recorder produces", () => {
    // The offset of the last chunk is where it starts, so its own one to two seconds of audio are
    // never in the assertion; container framing adds a fraction more.
    const result = reconcileRecordedDuration({ assertedSeconds: 1798.2, trueSeconds: 1800 });

    expect(result.outcome).toBe("within_tolerance");
    expect(result.shortfallSeconds).toBeCloseTo(1.8, 5);
  });

  it("tolerates several reconnect gaps in a long recording", () => {
    // Four reconnects, each losing a couple of seconds of continuity, over two hours.
    const result = reconcileRecordedDuration({
      assertedSeconds: 2 * HOUR - 9,
      trueSeconds: 2 * HOUR,
    });

    expect(result.outcome).toBe("within_tolerance");
  });

  it("flags an assertion that falls short by more than drift explains", () => {
    const result = reconcileRecordedDuration({ assertedSeconds: HOUR / 2, trueSeconds: HOUR });

    expect(result.outcome).toBe("understated");
    expect(result.shortfallSeconds).toBe(HOUR / 2);
    expect(result.billableSeconds).toBe(HOUR);
  });

  it("judges a short recording by the absolute allowance", () => {
    // Twenty percent short, but only twelve seconds of it: too little to be worth an alert.
    const withinAbsolute = reconcileRecordedDuration({ assertedSeconds: 48, trueSeconds: 60 });
    expect(withinAbsolute.outcome).toBe("within_tolerance");
    expect(withinAbsolute.toleratedSeconds).toBe(DEFAULT_DURATION_TOLERANCE.absoluteSeconds);

    const pastAbsolute = reconcileRecordedDuration({ assertedSeconds: 30, trueSeconds: 120 });
    expect(pastAbsolute.outcome).toBe("understated");
  });

  it("judges a long recording by the relative allowance", () => {
    // Two minutes short of four hours is more than the absolute allowance and well inside the
    // relative one — the sort of gap accumulated rounding can still produce.
    const drift = reconcileRecordedDuration({
      assertedSeconds: 4 * HOUR - 120,
      trueSeconds: 4 * HOUR,
    });
    expect(drift.outcome).toBe("within_tolerance");
    expect(drift.toleratedSeconds).toBeCloseTo(0.05 * 4 * HOUR, 5);

    const abuse = reconcileRecordedDuration({ assertedSeconds: 3 * HOUR, trueSeconds: 4 * HOUR });
    expect(abuse.outcome).toBe("understated");
  });

  it("never flags an assertion that is at or above the truth", () => {
    // A reconnect that lost audio: the recorder counted time the file does not contain.
    const result = reconcileRecordedDuration({ assertedSeconds: HOUR, trueSeconds: HOUR / 2 });

    expect(result.outcome).toBe("within_tolerance");
    expect(result.shortfallSeconds).toBeLessThan(0);
    // The truth is the authority in both directions: nobody is charged for audio that was never
    // produced, either.
    expect(result.billableSeconds).toBe(HOUR / 2);
  });

  it("honors a deployment's own tolerance", () => {
    const strict = reconcileRecordedDuration({
      assertedSeconds: 1795,
      trueSeconds: 1800,
      tolerance: { absoluteSeconds: 2, relative: 0 },
    });

    expect(strict.outcome).toBe("understated");
  });

  it("compares nothing when the backend reported no duration", () => {
    const result = reconcileRecordedDuration({ assertedSeconds: 1800, trueSeconds: null });

    expect(result.outcome).toBe("unknown");
    expect(result.billableSeconds).toBe(1800);
  });

  it("compares nothing when the recording asserted no duration", () => {
    // A manifest written before the assertion was carried into the pipeline.
    const result = reconcileRecordedDuration({ assertedSeconds: null, trueSeconds: 1800 });

    expect(result.outcome).toBe("unknown");
    expect(result.billableSeconds).toBe(1800);
  });

  it("keeps a nonsensical number out of the accounting", () => {
    const result = reconcileRecordedDuration({ assertedSeconds: Number.NaN, trueSeconds: -5 });

    expect(result.billableSeconds).toBe(0);
    expect(result.outcome).toBe("within_tolerance");
  });
});

describe("billableRecordedSeconds", () => {
  it("charges the reconciled duration once there is one", () => {
    expect(billableRecordedSeconds({ assertedSeconds: 60, reconciledSeconds: 1800 })).toBe(1800);
  });

  it("charges the assertion while the meeting is still waiting for its transcript", () => {
    expect(billableRecordedSeconds({ assertedSeconds: 1800, reconciledSeconds: null })).toBe(1800);
  });

  it("does not turn a backend that reports zero into a free recording", () => {
    expect(billableRecordedSeconds({ assertedSeconds: 1800, reconciledSeconds: 0 })).toBe(1800);
  });
});
