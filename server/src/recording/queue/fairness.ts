/**
 * Queue fairness: stopping one user from monopolizing the GPU.
 *
 * The transcription queue is served by a small number of GPU workers, and a job can take minutes.
 * Without any ordering rule, a user who finalizes twenty recordings at once puts twenty jobs at the
 * head of the queue, and everybody else waits behind all of them.
 *
 * THE MECHANISM, IN ONE SENTENCE: a job is enqueued with a pg-boss priority equal to the negative
 * count of jobs that user already has waiting, so a user's first job outranks their second, which
 * outranks their third, and a newcomer's first job outranks all of them.
 *
 * pg-boss serves higher priority first, so the effect is round-robin-ish without any scheduler:
 * with users A (five jobs queued) and B (none), B's next job has priority 0 and A's has -5, so B
 * goes first. It costs one count query per enqueue — which happens once per finished recording,
 * not per chunk — and it needs no state of its own, which means nothing to reconcile after a
 * restart: the queue itself is the state.
 *
 * WHAT THIS DELIBERATELY IS NOT: a per-user concurrency cap. That would need a scheduler holding
 * jobs back and deciding when to release them, which is a second source of truth about what is
 * running. Priority is a property of a row that is already there.
 */

/**
 * Priority for the next job of a user who already has `pendingJobs` waiting.
 *
 * Clamped so a user with a pathological backlog cannot push the value out of the integer range the
 * queue column holds; past the clamp everything of theirs is equally last, which is the right
 * behavior anyway.
 */
export const MAX_FAIRNESS_PENALTY = 1_000;

export function fairnessPriority(pendingJobs: number): number {
  if (!Number.isFinite(pendingJobs) || pendingJobs <= 0) return 0;
  return -Math.min(Math.floor(pendingJobs), MAX_FAIRNESS_PENALTY);
}
