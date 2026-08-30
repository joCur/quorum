import { toast as sonner } from "sonner";

/**
 * Transient confirmations.
 *
 * The rule this wrapper exists to hold: **a toast confirms a completed user action, and nothing
 * else.** Saving a template, deleting a meeting — moments where the user did something and the
 * screen alone does not say clearly enough that it worked.
 *
 * Never for background pipeline progress. Transcription and summarization run as server-side
 * jobs that finish minutes later, without the user asking at that moment; those states belong to
 * the status badge and the processing stepper, which show them where the user looks for them.
 * A toast for them would interrupt an unrelated screen to report something nobody was waiting
 * for. Resting states stay silent.
 *
 * Failures use `failure`, which is still a completed user action — one that did not work.
 */
export const notify = {
  /** Confirms that something the user did succeeded. */
  success(message: string): void {
    sonner.success(message);
  },

  /** Reports that something the user did failed. */
  failure(message: string): void {
    sonner.error(message);
  },
};
