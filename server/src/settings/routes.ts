import type { FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { UserSettingsUpdateSchema, type UserSettings } from "@quorum/shared";
import {
  UserSettingsUnavailableError,
  type UserSettingsScope,
  type UserSettingsStore,
} from "./repository.js";

export interface UserSettingsRoutesOptions {
  store: UserSettingsStore;
  /** Route prefix; the default matches the client's API base. */
  prefix?: string;
}

/**
 * The user's own preferences: read them, change them.
 *
 * SCOPING (ADR-001): tenant and user come from `request.requireContext()`, i.e. from the validated
 * access token. There is no id in the path and none in the body — a caller can only ever address
 * their own row, which is why these two routes need no ownership check of their own.
 *
 * The update is a partial: a field the body does not name is left as it is, so a client that
 * predates a preference cannot silently reset it by saving the ones it knows about. The response
 * is the full settings object rather than 204, because that is what the screen renders next and
 * it saves a round trip that could otherwise show a stale value.
 */
const userSettingsRoutesImpl: FastifyPluginAsync<UserSettingsRoutesOptions> = async (
  app,
  options,
) => {
  const prefix = options.prefix ?? "/api/settings";
  const store = options.store;

  app.get(prefix, async (request) => {
    const body: UserSettings = await store.findSettings(scopeOf(request.requireContext()));
    return body;
  });

  app.put(prefix, async (request, reply) => {
    const update = UserSettingsUpdateSchema.safeParse(request.body ?? {});
    if (!update.success) {
      return reply.code(400).send({
        error: "invalid_settings",
        message: "The settings could not be read.",
      });
    }
    try {
      const body: UserSettings = await store.updateSettings(
        scopeOf(request.requireContext()),
        update.data,
      );
      return body;
    } catch (error) {
      return unavailable(error, reply);
    }
  });
};

/**
 * The schema cannot hold the preference yet — the worker that owns `user_settings` has not
 * applied its migrations. 503 rather than 500: nothing is wrong with the request, and it will
 * succeed once the worker has come up, which is what "try again shortly" tells the caller.
 */
function unavailable(error: unknown, reply: FastifyReply): FastifyReply {
  if (!(error instanceof UserSettingsUnavailableError)) throw error;
  return reply.code(503).send({
    error: "settings_unavailable",
    message: "The setting could not be saved right now. Try again shortly.",
  });
}

function scopeOf(context: { tenantId: string; userId: string }): UserSettingsScope {
  return { tenantId: context.tenantId, userId: context.userId };
}

export const userSettingsRoutes = fp(userSettingsRoutesImpl, {
  name: "quorum-user-settings",
  fastify: "5.x",
});

export default userSettingsRoutes;
