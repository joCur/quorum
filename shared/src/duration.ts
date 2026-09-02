/**
 * Recorded duration: what the client asserted, what the audio actually contains, and which of the
 * two a quota is allowed to believe.
 *
 * WHY THIS EXISTS. While a recording is live, the only duration anybody has is the one the client
 * asserts: each chunk frame carries the audio-time offset it starts at, and the recording endpoint
 * takes the largest offset it has seen as the session's recorded seconds. That number drives the
 * recorded-time limits, and a client is free to lie about it — understating offsets buys audio time
 * the quota never charges for, and audio time is what buys GPU seconds and model tokens.
 *
 * Decoding chunks as they arrive would close that hole at the source, and it is the wrong trade:
 * it puts a decoder on the hot path of every recording to catch a case that has never been
 * observed. Instead the true duration is taken from the transcription result — the backend decodes
 * the audio anyway, and reports exactly how long it was — and reconciled against the assertion
 * afterwards. The wall-clock session-lifetime ceiling stays the live bound in the meantime.
 *
 * WHAT HAPPENS ON A MISMATCH. The reconciled duration is what counts against the quota, and a
 * significant understatement is flagged for operators as structured log data. Nothing is enforced
 * against the user in this cut: the point is to find out whether this ever happens outside a
 * threat model before anyone is refused a recording over it.
 */

/** How far the assertion may fall short of the truth before it is treated as an understatement. */
export interface DurationTolerance {
  /** Seconds of shortfall that are never flagged, however short the recording. */
  readonly absoluteSeconds: number;
  /** Shortfall as a fraction of the true duration that is never flagged. */
  readonly relative: number;
}

/**
 * Defaults chosen against the drift an honest recorder actually produces.
 *
 * A client's asserted duration is systematically a little short, for reasons that have nothing to
 * do with cheating:
 *
 * - The offset a chunk carries is where it *starts*. The audio inside the last chunk — one to two
 *   seconds (ADR-002) — is therefore never counted by the assertion, but it is in the file the
 *   transcription backend decodes.
 * - Container and codec framing round chunk boundaries, and a backend reports the decoded length,
 *   which includes padding the recorder never accounted for.
 * - A reconnect resumes from `persistedSeq`, and the offsets on both sides of the gap are the
 *   client's own clock rather than a continuous one.
 *
 * Together that is a handful of seconds, not a minute. Sixty seconds of absolute tolerance is
 * roughly an order of magnitude above it, so a flagged recording is one where the numbers disagree
 * about something real. The relative term takes over for long recordings, where per-chunk rounding
 * accumulates and where five percent of the truth is still far more than framing can explain — and
 * a client that halves its offsets to record twice as long trips both terms immediately.
 */
export const DEFAULT_DURATION_TOLERANCE: DurationTolerance = {
  absoluteSeconds: 60,
  relative: 0.05,
};

/** Whether a reconciliation found the assertion believable. */
export type DurationReconciliationOutcome =
  /** One of the two numbers is missing, so there is nothing to compare. */
  | "unknown"
  /** The assertion is at or above the truth, or short of it only by benign drift. */
  | "within_tolerance"
  /** The assertion falls short of the truth by more than drift explains. */
  | "understated";

export interface DurationReconciliation {
  outcome: DurationReconciliationOutcome;
  /** What the client claimed it recorded, or `null` when it claimed nothing. */
  assertedSeconds: number | null;
  /** What the audio turned out to contain, or `null` when the truth is unknown. */
  trueSeconds: number | null;
  /** How far the assertion fell short: positive means the client understated. Zero when unknown. */
  shortfallSeconds: number;
  /** The shortfall a recording of this length is allowed before it is flagged. Zero when unknown. */
  toleratedSeconds: number;
  /** The number a quota should charge for this recording. */
  billableSeconds: number;
}

/**
 * Compares the client's assertion against the duration the audio really had.
 *
 * The billable answer is the true duration whenever there is one — not the larger of the two. An
 * assertion above the truth is not a second thing to bill for: it means the recorder counted time
 * the audio does not contain (a lost reconnect gap, a stopped microphone), and charging for audio
 * that never reached the pipeline would charge for cost that was never incurred. The truth is the
 * authority in both directions, and the flag only ever concerns the direction that is exploitable.
 */
export function reconcileRecordedDuration(input: {
  assertedSeconds: number | null;
  trueSeconds: number | null;
  tolerance?: DurationTolerance;
}): DurationReconciliation {
  const tolerance = input.tolerance ?? DEFAULT_DURATION_TOLERANCE;
  const asserted = input.assertedSeconds === null ? null : sanitize(input.assertedSeconds);
  const truth = input.trueSeconds === null ? null : sanitize(input.trueSeconds);

  // Nothing to compare: a manifest that predates the assertion, or a backend that reported no
  // duration. Neither is a discrepancy, and neither is a reason to flag anybody.
  if (truth === null || asserted === null) {
    return {
      outcome: "unknown",
      assertedSeconds: asserted,
      trueSeconds: truth,
      shortfallSeconds: 0,
      toleratedSeconds: 0,
      billableSeconds: truth ?? asserted ?? 0,
    };
  }

  const shortfall = truth - asserted;
  const tolerated = Math.max(tolerance.absoluteSeconds, tolerance.relative * truth);
  return {
    outcome: shortfall > tolerated ? "understated" : "within_tolerance",
    assertedSeconds: asserted,
    trueSeconds: truth,
    shortfallSeconds: shortfall,
    toleratedSeconds: tolerated,
    billableSeconds: truth,
  };
}

/**
 * The seconds a quota charges for one meeting.
 *
 * The same rule the reconciliation applies, in the form the quota needs it: the reconciled
 * duration once the pipeline has produced one, the client's assertion until then. A meeting whose
 * transcription has not run yet still counts — a quota that waited for the pipeline would be
 * bypassed by never letting it finish.
 *
 * A reconciled zero is treated as no answer rather than as a free recording: a backend that
 * reports no duration at all must not turn into a discount.
 */
export function billableRecordedSeconds(input: {
  assertedSeconds: number;
  reconciledSeconds: number | null;
}): number {
  const asserted = sanitize(input.assertedSeconds);
  const reconciled = input.reconciledSeconds === null ? null : sanitize(input.reconciledSeconds);
  return reconciled !== null && reconciled > 0 ? reconciled : asserted;
}

/** Keeps a NaN, an infinity or a negative number out of an accounting decision. */
function sanitize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
