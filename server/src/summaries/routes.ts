import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import {
  JobSchema,
  RegenerateSummaryRequestSchema,
  SYSTEM_TEMPLATE_ID,
  type Job,
  type SummaryJobAccepted,
} from "@quorum/shared";
import type { MeetingStore } from "../meetings/repository.js";
import type { JobQueue } from "../recording/types.js";
import type { SummaryTemplateStore } from "../templates/repository.js";

export interface SummaryRoutesOptions {
  meetings: MeetingStore;
  templates: SummaryTemplateStore;
  queue: JobQueue;
  /** Route prefix; the default matches the client's API base. */
  prefix?: string;
  /** Injectable clock so the enqueued job's timestamp is assertable. */
  now?: () => Date;
}

const MeetingParamsSchema = z.object({
  meetingId: z.string().uuid(),
});

/**
 * Producing a summary of an existing transcript again — the "Regenerate" action of the summary
 * view (ADR-004 §3: a meeting may have many summaries, one active per template).
 *
 * SCOPING (ADR-001): the meeting, the transcript and the template are all resolved under the
 * tenant and user of the validated access token. A meeting or template outside that scope
 * matches nothing and is answered with 404 — never 403, which would confirm that the id exists.
 *
 * WHAT IS NOT DONE HERE: no `queued` row is written to the job table. The pipeline's rule is one
 * writer per fact, and the job row belongs to the worker that runs the job
 * (`server/src/meetings/status.ts` spells out why the enqueuing side stays out of it). The
 * accepted job is returned in the response instead, so the caller can show that work has started
 * and then follow it in the meeting's job list once the worker picks it up.
 */
const summaryRoutesImpl: FastifyPluginAsync<SummaryRoutesOptions> = async (app, options) => {
  const prefix = options.prefix ?? "/api/meetings";
  const now = options.now ?? (() => new Date());

  app.post(`${prefix}/:meetingId/summaries`, async (request, reply) => {
    const context = request.requireContext();
    const params = MeetingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(meetingNotFound());

    const body = RegenerateSummaryRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "This summary request could not be read.",
      });
    }

    const scope = { tenantId: context.tenantId, userId: context.userId };
    const found = await options.meetings.findMeeting(scope, params.data.meetingId);
    if (!found) return reply.code(404).send(meetingNotFound());

    // Only the active transcript is offered. Older ones are still stored and still referenced by
    // the summaries made from them (ADR-003 §3), but asking for a summary of a superseded
    // transcript is not something the product currently means to let anyone do.
    const transcript = found.transcript;
    if (!transcript) {
      return reply.code(409).send({
        error: "transcript_not_available",
        message: "This meeting has no transcript to summarize yet.",
      });
    }
    if (body.data.transcriptId !== undefined && body.data.transcriptId !== transcript.id) {
      return reply.code(409).send({
        error: "transcript_not_available",
        message: "This meeting has no transcript to summarize yet.",
      });
    }

    const templateId = body.data.templateId ?? SYSTEM_TEMPLATE_ID;
    const template = await options.templates.findTemplate(scope, templateId);
    if (!template) {
      return reply
        .code(404)
        .send({ error: "template_not_found", message: "No template with this id exists." });
    }

    // One summary run at a time per meeting. Without this, a double click is two model calls on
    // the same transcript, and the second one supersedes the first for no reason. It is a
    // best-effort guard — two requests that arrive in the same instant can both pass — but the
    // database still keeps only one active summary per template, so the cost is a wasted call,
    // never inconsistent data.
    const running = found.jobs.some(
      (job) => job.type === "summarize" && (job.status === "queued" || job.status === "running"),
    );
    if (running) {
      return reply.code(409).send({
        error: "summary_in_progress",
        message: "A summary of this meeting is already being written.",
      });
    }

    const job: Job = JobSchema.parse({
      id: randomUUID(),
      meetingId: found.meeting.id,
      type: "summarize",
      status: "queued",
      progress: null,
      error: null,
      resultId: null,
      createdAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
    });

    await options.queue.enqueueSummarize({
      jobId: job.id,
      meetingId: found.meeting.id,
      tenantId: context.tenantId,
      userId: context.userId,
      sessionId: found.meeting.sessionId,
      transcriptId: transcript.id,
      templateId: template.id,
      createdAt: job.createdAt,
    });

    request.log.info(
      {
        event: "summary.regenerate_queued",
        meetingId: found.meeting.id,
        sessionId: found.meeting.sessionId,
        jobId: job.id,
        templateId: template.id,
      },
      "queued a summary of an existing transcript",
    );

    const accepted: SummaryJobAccepted = {
      job,
      templateId: template.id,
      transcriptId: transcript.id,
    };
    return reply.code(202).send(accepted);
  });
};

function meetingNotFound(): { error: string; message: string } {
  return { error: "meeting_not_found", message: "No meeting with this id exists." };
}

export const summaryRoutes = fp(summaryRoutesImpl, {
  name: "quorum-summaries",
  fastify: "5.x",
});

export default summaryRoutes;
