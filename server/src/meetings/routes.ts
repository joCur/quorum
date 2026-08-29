import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import type { MeetingDetail, MeetingList } from "@quorum/shared";
import { DEFAULT_MEETING_LIMIT, MAX_MEETING_LIMIT, type MeetingStore } from "./repository.js";

export interface MeetingRoutesOptions {
  store: MeetingStore;
  /** Route prefix; the default matches the client's API base. */
  prefix?: string;
}

const ListQuerySchema = z.object({
  /** Case-insensitive substring match on the meeting title. */
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(MAX_MEETING_LIMIT).default(DEFAULT_MEETING_LIMIT),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const MeetingParamsSchema = z.object({
  meetingId: z.string().uuid(),
});

/**
 * Read API for meetings.
 *
 * SCOPING (ADR-001): the tenant and the user come from `request.requireContext()`, i.e. from the
 * validated access token, and are passed into every query as part of the predicate. A meeting id
 * belonging to another tenant or another user therefore matches no row and is answered with 404,
 * never 403 — a 403 would confirm that the id exists.
 */
const meetingRoutesImpl: FastifyPluginAsync<MeetingRoutesOptions> = async (app, options) => {
  const prefix = options.prefix ?? "/api/meetings";

  app.get(prefix, async (request, reply) => {
    const context = request.requireContext();
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: "invalid_query",
        message: "The list query parameters are not valid.",
      });
    }

    const meetings = await options.store.listMeetings(
      { tenantId: context.tenantId, userId: context.userId },
      { search: query.data.q, limit: query.data.limit, offset: query.data.offset },
    );
    const body: MeetingList = { meetings };
    return body;
  });

  app.get(`${prefix}/:meetingId`, async (request, reply) => {
    const context = request.requireContext();
    const params = MeetingParamsSchema.safeParse(request.params);
    // A malformed id cannot identify a meeting, and saying so would distinguish "not a meeting
    // id" from "not your meeting". Both are 404.
    if (!params.success) return reply.code(404).send(notFound());

    const found = await options.store.findMeeting(
      { tenantId: context.tenantId, userId: context.userId },
      params.data.meetingId,
    );
    if (!found) return reply.code(404).send(notFound());

    const body: MeetingDetail = {
      meeting: found.meeting,
      transcript: found.transcript,
      summaries: found.summaries,
      jobs: found.jobs,
    };
    return body;
  });
};

function notFound(): { error: string; message: string } {
  return { error: "meeting_not_found", message: "No meeting with this id exists." };
}

export const meetingRoutes = fp(meetingRoutesImpl, {
  name: "quorum-meetings",
  fastify: "5.x",
});

export default meetingRoutes;
