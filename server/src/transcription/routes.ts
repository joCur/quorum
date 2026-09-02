import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import {
  isRetryableJobErrorCode,
  normalizeVocabulary,
  resolveTranscriptionLanguage,
  type Job,
  type TranscriptionJobAccepted,
} from "@quorum/shared";
import type { MeetingStore, RequeueOutcome } from "../meetings/repository.js";
import { TRANSCRIBE_DEAD_LETTER_QUEUE, TRANSCRIBE_QUEUE } from "../recording/queue/pg-boss.js";
import type { JobQueue, RecordingStorage, UserPreferences } from "../recording/types.js";

export interface TranscriptionRoutesOptions {
  meetings: MeetingStore;
  queue: JobQueue;
  /**
   * Object storage, for the session record the retry reads its language from. The recording is
   * the only place that still knows what was asked for when it was made.
   */
  storage: RecordingStorage;
  /**
   * The user's defaults, the second link of the language chain. Optional for the same reason it
   * is optional on the recording endpoint: without one the chain simply has a link fewer.
   */
  preferences?: UserPreferences | undefined;
  /** Route prefix; the default matches the client's API base. */
  prefix?: string;
}

const MeetingParamsSchema = z.object({
  meetingId: z.string().uuid(),
});

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
 * NO SECOND RUN OF ONE JOB IS POSSIBLE, and the guard that matters is not the obvious one. A job
 * row saying `failed` does not mean nobody is running the job: the worker writes that row on
 * *every* attempt, including the ones pg-boss is about to repeat by itself, and pg-boss's
 * `standard` policy makes `singletonKey` deduplicate nothing. So the decision is made against the
 * queue rather than against the row, inside the transaction that moves it
 * (`MeetingStore.requeueFailedJob`): a live entry means the job is already going to run, and the
 * retry is refused. The rate limit below is then only a ceiling on the asking, not the thing that
 * keeps the pipeline from being asked twice.
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

      // The rows arrive oldest first, so the last transcribe row is the attempt the user is
      // looking at. There is at most one per job id; a meeting the worker never reached has none.
      const latest = found.jobs.filter((job) => job.type === "transcribe").at(-1);
      if (!latest || latest.status === "succeeded" || latest.status === "canceled") {
        return reply.code(409).send(nothingToRetry());
      }

      // A row that is not failed is either a run in flight or one stranded by a crash, and only
      // the queue can tell those apart — so that judgement is left to the store, which asks it
      // under the same lock it moves the row with. What is decided here is the question the row
      // alone can answer: whether the failure it recorded is one that repeating could survive.
      if (latest.status === "failed" && !isRetryableJobErrorCode(latest.error?.code ?? "")) {
        return reply.code(409).send({
          error: "transcription_not_retryable",
          message: "This transcription failed for a reason another attempt cannot change.",
        });
      }

      // What this recording was made with. Resolved before the row is touched, so its two
      // lookups happen outside the lock the requeue holds rather than inside it.
      const { language, vocabulary } = await transcriptionPreferences(
        scope,
        found.meeting.sessionId,
        options,
        request,
      );

      let outcome: RequeueOutcome;
      try {
        outcome = await options.meetings.requeueFailedJob(scope, {
          meetingId: found.meeting.id,
          jobId: latest.id,
          queue: { name: TRANSCRIBE_QUEUE, deadLetter: TRANSCRIBE_DEAD_LETTER_QUEUE },
          enqueue: () =>
            options.queue.enqueueTranscribe({
              jobId: latest.id,
              meetingId: found.meeting.id,
              tenantId: context.tenantId,
              userId: context.userId,
              sessionId: found.meeting.sessionId,
              language,
              vocabulary,
            }),
        });
      } catch (error) {
        // Whatever failed — the queue insert or the database around it — took the row move with
        // it, so the meeting still reports the failure it has and the action is still there to
        // press. Nothing to undo, only to report.
        request.log.error(
          {
            event: "transcription.retry_enqueue_failed",
            meetingId: found.meeting.id,
            jobId: latest.id,
            err: error,
          },
          "could not hand a transcription back to the queue",
        );
        return reply.code(503).send({
          error: "queue_unavailable",
          message: "The transcription could not be started right now. Try again in a moment.",
        });
      }

      if (outcome === "in-progress") {
        return reply.code(409).send({
          error: "transcription_in_progress",
          message: "This meeting is already being transcribed.",
        });
      }
      if (outcome === "nothing-to-retry") {
        // The row changed under us between the read and the lock — it succeeded, or the meeting
        // was deleted. Either way there is nothing here to run again any more.
        return reply.code(409).send(nothingToRetry());
      }

      request.log.info(
        {
          event: "transcription.retry_queued",
          meetingId: found.meeting.id,
          sessionId: found.meeting.sessionId,
          jobId: latest.id,
          previousStatus: latest.status,
          previousCode: latest.error?.code ?? null,
        },
        "queued a transcription again at the user's request",
      );

      // The job as it now stands, not as it was read: the row was moved to `queued` a moment ago
      // and the caller's screen is about to render this.
      const job: Job = {
        ...latest,
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

/**
 * What a retried transcription is asked for: the language, and the custom vocabulary to bias
 * recognition towards.
 *
 * The language runs the same chain the recording endpoint runs when it hands a finished recording
 * over — the meeting's own choice, then the user's default — and deliberately in the same *order
 * of reading*: the meeting's choice comes from the session record written at `session.start`,
 * which is the only place that still knows what was asked for when the recording was made.
 * Re-deriving it from the user's current default alone would silently retranscribe a German
 * meeting in whatever the user has since switched to, which is exactly the drift the language
 * travels in the payload to avoid.
 *
 * The vocabulary has no such record and is deliberately read as it stands now. Unlike the
 * language, a changed vocabulary cannot decode the recording as the wrong thing — it only biases,
 * and the reason a user edits the list after a failed transcription is usually that they want the
 * next attempt to know a term the last one got wrong. Retrying with the current list is what
 * makes that work.
 *
 * THE ASYMMETRY IS THE POINT, AND IT IS EASY TO MISREAD. Both values are snapshotted into the job
 * payload when a recording is handed over, so that a *redelivery* of that job — a crash, a queue
 * retry — reproduces what was asked for then. That is a different question from what a *user*
 * asking to retry should get, and only here are the two allowed to diverge: the language is
 * re-derived from the session record, the vocabulary from the user's settings. The snapshot sites
 * (`recording/session.ts`, `recording/types.ts`, the worker's `payload.ts`) carry a note pointing
 * here; do not reconcile one side into the other without changing all four.
 *
 * A lookup that fails costs the preference, not the retry. The remaining links of the language
 * chain — the deployment default, then autodetect — are the worker's (ADR-005), so a retry with
 * one link missing still produces a transcript.
 */
async function transcriptionPreferences(
  scope: { tenantId: string; userId: string },
  sessionId: string,
  options: TranscriptionRoutesOptions,
  request: { log: { warn: (fields: object, message: string) => void } },
): Promise<{ language: string | null; vocabulary: string[] }> {
  let chosen: string | null = null;
  try {
    const session = await options.storage.getSession(scope.tenantId, scope.userId, sessionId);
    chosen = session?.language ?? null;
  } catch (error) {
    request.log.warn(
      { event: "transcription.retry_language_unreadable", sessionId, err: error },
      "could not read the recording's chosen language; leaving it to the rest of the chain",
    );
  }

  let userDefault: string | null = null;
  let vocabulary: string[] = [];
  try {
    const settings = await options.preferences?.findSettings(scope);
    userDefault = settings?.transcriptionLanguage ?? null;
    vocabulary = normalizeVocabulary(settings?.vocabulary ?? []);
  } catch (error) {
    request.log.warn(
      { event: "transcription.retry_preferences_unreadable", err: error },
      "could not read the user's transcription preferences; leaving them to the pipeline",
    );
  }

  return { language: resolveTranscriptionLanguage(chosen, userDefault), vocabulary };
}

function meetingNotFound(): { error: string; message: string } {
  return { error: "meeting_not_found", message: "No meeting with this id exists." };
}

function nothingToRetry(): { error: string; message: string } {
  return {
    error: "transcription_not_failed",
    message: "This meeting has no failed transcription to run again.",
  };
}

export const transcriptionRoutes = fp(transcriptionRoutesImpl, {
  name: "quorum-transcription",
  fastify: "5.x",
});

export default transcriptionRoutes;
