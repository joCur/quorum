import { Readable } from "node:stream";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { RenameMeetingRequestSchema, type MeetingDetail, type MeetingList } from "@quorum/shared";
import type { RecordingStorage } from "../recording/types.js";
import { audioContentType, audioLayout, resolveRange, slicesForRange } from "./audio.js";
import { DEFAULT_MEETING_LIMIT, MAX_MEETING_LIMIT, type MeetingStore } from "./repository.js";

export interface MeetingRoutesOptions {
  store: MeetingStore;
  /** Object storage, for playback and for the storage half of the deletion cascade. */
  storage: RecordingStorage;
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

  /**
   * Renaming a meeting, and clearing its name.
   *
   * This is the only writer of the title a person chooses, and it exists because the summary may
   * name a recording nobody named (see the ADR on machine-filled fields): a suggestion its owner
   * cannot correct would not be a suggestion. Clearing the field is allowed and returns the
   * meeting to unnamed — the state in which the next summary may name it again, which is the
   * same offer any unnamed recording gets.
   *
   * PATCH rather than PUT: the request carries the one field a user owns; everything else about
   * a meeting is derived or written by the pipeline.
   */
  app.patch(`${prefix}/:meetingId`, async (request, reply) => {
    const context = request.requireContext();
    const params = MeetingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound());

    const body = RenameMeetingRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "This title could not be read.",
      });
    }

    const scope = { tenantId: context.tenantId, userId: context.userId };
    const renamed = await options.store.renameMeeting(
      scope,
      params.data.meetingId,
      body.data.title,
    );
    if (!renamed) return reply.code(404).send(notFound());

    request.log.info(
      { event: "meeting.renamed", meetingId: renamed.id, cleared: renamed.title === null },
      renamed.title === null ? "cleared a meeting's name" : "renamed a meeting",
    );
    return renamed;
  });

  /**
   * Audio playback.
   *
   * The audio is delivered by this endpoint and never by a URL that points at object storage:
   * a presigned URL would be a bearer token for the recording, valid for whoever holds it and
   * impossible to withdraw before it expires. Streaming through the API means the tenant and
   * user check happens on every single request, including every seek.
   */
  app.get(`${prefix}/:meetingId/audio`, async (request, reply) => {
    const context = request.requireContext();
    const params = MeetingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound());

    const scope = { tenantId: context.tenantId, userId: context.userId };
    const found = await options.store.findMeeting(scope, params.data.meetingId);
    if (!found) return reply.code(404).send(notFound());

    const objects = await options.storage.listSessionObjects({
      ...scope,
      sessionId: found.meeting.sessionId,
    });
    const layout = audioLayout(objects);
    if (layout.totalBytes === 0) {
      // A recording that is still running, or one whose chunks are gone. Either way there is
      // nothing to play yet; the meeting itself stays reachable.
      return reply.code(404).send({
        error: "audio_not_available",
        message: "This meeting has no playable audio.",
      });
    }

    const range = resolveRange(request.headers.range, layout.totalBytes);
    // The recording is personal data: no shared cache may keep a copy.
    reply.header("Accept-Ranges", "bytes").header("Cache-Control", "private, no-store");

    if (range.kind === "unsatisfiable") {
      return reply
        .header("Content-Range", `bytes */${layout.totalBytes}`)
        .code(416)
        .send({ error: "range_not_satisfiable", message: "The requested range does not exist." });
    }

    reply.header("Content-Type", audioContentType(found.meeting.audioFormat));

    const selected =
      range.kind === "partial" ? range.range : { from: 0, to: layout.totalBytes - 1 };
    const slices = slicesForRange(layout, selected);
    const length = selected.to - selected.from + 1;

    reply.header("Content-Length", String(length));
    if (range.kind === "partial") {
      reply.header("Content-Range", `bytes ${selected.from}-${selected.to}/${layout.totalBytes}`);
      reply.code(206);
    }

    // Chunks are streamed one object at a time rather than concatenated in memory: a long
    // recording is hundreds of megabytes, and playback should not need to hold it.
    const storage = options.storage;
    return reply.send(
      Readable.from(
        (async function* stream() {
          for (const slice of slices) {
            yield Buffer.from(await storage.readObject(slice.key, slice.range));
          }
        })(),
      ),
    );
  });

  /**
   * Deletion (ADR-001): real, immediate and complete — no soft delete, no trash.
   *
   * Storage goes first, the database second. Both steps are idempotent, so the order decides
   * what a crash in between leaves behind: this way the meeting is still listed and the user can
   * simply delete it again. The reverse order would leave orphaned audio that nothing points at
   * any more, which is the one outcome the deletion promise cannot survive.
   */
  app.delete(`${prefix}/:meetingId`, async (request, reply) => {
    const context = request.requireContext();
    const params = MeetingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound());

    const scope = { tenantId: context.tenantId, userId: context.userId };
    const found = await options.store.findMeeting(scope, params.data.meetingId);
    if (!found) return reply.code(404).send(notFound());

    const objects = await options.storage.listSessionObjects({
      ...scope,
      sessionId: found.meeting.sessionId,
    });
    await options.storage.deleteObjects(objects.map((object) => object.key));

    const deleted = await options.store.deleteMeeting(scope, params.data.meetingId);
    if (!deleted) return reply.code(404).send(notFound());

    request.log.info(
      {
        event: "meeting.deleted",
        meetingId: params.data.meetingId,
        sessionId: found.meeting.sessionId,
        objects: objects.length,
      },
      "deleted a meeting and everything derived from it",
    );
    return reply.code(204).send();
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
