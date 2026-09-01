import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { isRetryableJobErrorCode, type Job, type TranscriptionJobAccepted } from "@quorum/shared";
import type { MeetingStore } from "../meetings/repository.js";
import type { JobQueue } from "../recording/types.js";

export interface TranscriptionRoutesOptions {
  meetings: MeetingStore;
  queue: JobQueue;
  /** Route prefix; the default matches the client's API base. */
  prefix?: string;
}

const MeetingParamsSchema = z.object({
  meetingId: z.string().uuid(),
});

/** What the caller is told when the compensating write below had to run. */
const ENQUEUE_FAILED = {
  code: "TRANSCRIPTION_UNAVAILABLE",
  message: "the retry could not be placed on the queue",
} as const;

/**
 * Running a meeting's transcription again after it failed.
 *
 * Until this existed, a dead-lettered transcription could only be recovered by the operator
 * redrive in `docs/runbooks/pipeline.md`: the recording was safe, the transcript never came, and
 * the person who owned the meeting could do nothing about it. This is that redrive, narrowed to
 * one job and handed to the one user who is allowed to ask for it.
 *
 * SCOPING (ADR-001): the meeting and the job are resolved under the tenant and user of the
 * validated access token. A meeting outside that scope matches nothing and is answered with 404,
 * never 403 — a 403 would confirm that the id exists. Nothing about *which* job is replayed comes
 * from the request: it is the meeting's failed `transcribe` job or nothing at all.
 *
 * THE SAME JOB, NOT A NEW ONE. The queue entry is fresh, so the retry budget is fresh, but the
 * job id is the one that failed. That is what makes a replay idempotent rather than merely
 * repeated: the transcript id is derived from the job id (`worker/src/ids.ts`), so an attempt
 * that turns out to have succeeded after all overwrites nothing and inserts no second transcript
 * — the same property the operator redrive relies on.
 *
 * NO RETRY STORM IS POSSIBLE, for three reasons that stack:
 *  1. the endpoint accepts nothing but a job that is *currently* failed, so a second retry is
 *     refused until the first has run and failed again, which takes as long as a transcription;
 *  2. moving the row out of `failed` is a conditional update, so two requests that arrive in the
 *     same instant race for one row and only one of them wins;
 *  3. the route carries its own rate-limit counter against the small allowance every route that
 *     buys pipeline work is metered on.
 */
const transcriptionRoutesImpl: FastifyPluginAsync<TranscriptionRoutesOptions> = async (
  app,
  options,
) => {
  const prefix = options.prefix ?? "/api/meetings";

  // An accepted request here buys a transcription — GPU time, the most expensive thing this
  // system does — so the route is metered against the small allowance rather than the general
  // one, and against a counter of its own: browsing the meeting list must not spend the right to
  // ask for a transcript, and asking for one must not spend the right to browse. The decorator is
  // absent on an instance built without the rate-limit plugin, where an empty config simply
  // leaves the route on the general allowance.
  const rateLimit = app.hasDecorator("expensiveRateLimit")
    ? { rateLimit: app.expensiveRateLimit }
    : {};

  app.post(
    `${prefix}/:meetingId/transcription/retry`,
    { config: { ...rateLimit } },
    async (request, reply) => {
      const context = request.requireContext();
      const params = MeetingParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send(meetingNotFound());

      const scope = { tenantId: context.tenantId, userId: context.userId };
      const found = await options.meetings.findMeeting(scope, params.data.meetingId);
      if (!found) return reply.code(404).send(meetingNotFound());

      const transcribeJobs = found.jobs.filter((job) => job.type === "transcribe");
      if (transcribeJobs.some((job) => job.status === "queued" || job.status === "running")) {
        return reply.code(409).send({
          error: "transcription_in_progress",
          message: "This meeting is already being transcribed.",
        });
      }

      // The rows arrive oldest first, so the last failed one is the attempt the user is looking
      // at. There is at most one per job id; a meeting that never failed has none.
      const failed = transcribeJobs.filter((job) => job.status === "failed").at(-1);
      if (!failed) {
        return reply.code(409).send({
          error: "transcription_not_failed",
          message: "This meeting has no failed transcription to run again.",
        });
      }

      // The taxonomy of `shared/src/job.ts`, which is the pipeline's own: a failure that repeating
      // the job cannot undo is refused rather than sold as a second chance. The client hides the
      // action for the same codes, so reaching this is either a stale screen or a direct caller.
      if (!isRetryableJobErrorCode(failed.error?.code ?? "")) {
        return reply.code(409).send({
          error: "transcription_not_retryable",
          message: "This transcription failed for a reason another attempt cannot change.",
        });
      }

      // Written before the enqueue, and conditional on the row still being failed. Both halves
      // matter: it is the guard against two retries of one job, and it is what keeps the meeting
      // from reporting a failure the user has already acted on while the worker gets to the job.
      const requeued = await options.meetings.requeueFailedJob(scope, found.meeting.id, failed.id);
      if (!requeued) {
        return reply.code(409).send({
          error: "transcription_in_progress",
          message: "This meeting is already being transcribed.",
        });
      }

      try {
        await options.queue.enqueueTranscribe({
          jobId: failed.id,
          meetingId: found.meeting.id,
          tenantId: context.tenantId,
          userId: context.userId,
          sessionId: found.meeting.sessionId,
        });
      } catch (error) {
        // The row says `queued` and nothing is on the queue — a state nothing would ever leave.
        // Putting the failure back is what keeps the meeting honest and the action available.
        await options.meetings
          .restoreFailedJob(scope, found.meeting.id, failed.id, ENQUEUE_FAILED)
          .catch((restoreError: unknown) => {
            request.log.error(
              {
                event: "transcription.retry_restore_failed",
                meetingId: found.meeting.id,
                jobId: failed.id,
                err: restoreError,
              },
              "a retry never reached the queue and the job row could not be put back",
            );
          });
        request.log.error(
          {
            event: "transcription.retry_enqueue_failed",
            meetingId: found.meeting.id,
            jobId: failed.id,
            err: error,
          },
          "could not place a transcription retry on the queue",
        );
        return reply.code(503).send({
          error: "queue_unavailable",
          message: "The transcription could not be started right now. Try again in a moment.",
        });
      }

      request.log.info(
        {
          event: "transcription.retry_queued",
          meetingId: found.meeting.id,
          sessionId: found.meeting.sessionId,
          jobId: failed.id,
          previousCode: failed.error?.code ?? null,
        },
        "queued a transcription again at the user's request",
      );

      // The job as it now stands, not as it was read: the row was moved to `queued` a moment ago
      // and the caller's screen is about to render this.
      const job: Job = {
        ...failed,
        status: "queued",
        progress: null,
        error: null,
        resultId: null,
        startedAt: null,
        finishedAt: null,
      };
      const accepted: TranscriptionJobAccepted = { job };
      return reply.code(202).send(accepted);
    },
  );
};

function meetingNotFound(): { error: string; message: string } {
  return { error: "meeting_not_found", message: "No meeting with this id exists." };
}

export const transcriptionRoutes = fp(transcriptionRoutesImpl, {
  name: "quorum-transcription",
  fastify: "5.x",
});

export default transcriptionRoutes;
