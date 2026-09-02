import fastifyWebsocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ServerMessage } from "@quorum/shared";
import { selectBearerSubprotocol } from "../auth/subprotocol.js";
import { UnauthorizedError } from "./context-provider.js";
import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_POLICY_VIOLATION,
  RecordingSessionHandler,
} from "./session.js";
import { MAX_CHUNK_PAYLOAD_BYTES } from "./audio-format.js";
import { StaticUserLimitsResolver, type UserLimitsResolver } from "../limits.js";
import { SessionRegistry } from "./limits.js";
import { CHUNK_HEADER_BYTES } from "@quorum/shared";
import type {
  JobQueue,
  MeetingRegistry,
  RecordingContextProvider,
  RecordingStorage,
  UserPreferences,
} from "./types.js";

export interface RecordingPluginOptions {
  storage: RecordingStorage;
  queue: JobQueue;
  contextProvider: RecordingContextProvider;
  /** Index that makes finished recordings appear in the meeting list. */
  meetings?: MeetingRegistry | undefined;
  /** The user's defaults; the source of the user-level link of the transcription language chain. */
  settings?: UserPreferences | undefined;
  path?: string;
  /**
   * Exempts the upgrade from the auth plugin's default-deny hook, so the context provider alone
   * decides the scope. Only the development header path sets this.
   */
  publicUpgrade?: boolean;
  /**
   * Where the abuse and cost limits of a user come from; defaults to the static resolver over
   * `DEFAULT_USER_LIMITS`.
   */
  limits?: UserLimitsResolver;
}

/**
 * WebSocket recording endpoint (ADR-002).
 *
 * Self-contained Fastify plugin: it registers `@fastify/websocket` itself and
 * touches no shared server state. The tenant/user scope comes from the injected
 * context provider, never from the plugin itself.
 */
const recordingPlugin: FastifyPluginAsync<RecordingPluginOptions> = async (app, options) => {
  const limits = options.limits ?? new StaticUserLimitsResolver();
  // One registry for the whole plugin instance: the parallel-session cap is about a user across
  // their connections, so it cannot live on a single connection. The cap itself comes from the
  // resolver, per user, at the moment a session is claimed.
  const registry = new SessionRegistry();

  if (!app.hasDecorator("websocketServer")) {
    await app.register(fastifyWebsocket, {
      options: {
        maxPayload: CHUNK_HEADER_BYTES + MAX_CHUNK_PAYLOAD_BYTES,
        // RFC 6455: the handshake response must echo one of the offered subprotocols, otherwise
        // the browser aborts the connection. Only the marker is echoed, never the token.
        handleProtocols: selectBearerSubprotocol,
      },
    });
  }

  app.get(
    options.path ?? "/ws/recording",
    { websocket: true, config: { public: options.publicUpgrade === true } },
    (socket, request) => {
      const connection = {
        send(message: ServerMessage): void {
          socket.send(JSON.stringify(message));
        },
        close(code: number, reason: string): void {
          socket.close(code, reason);
        },
      };

      const handler = new RecordingSessionHandler(connection, {
        storage: options.storage,
        queue: options.queue,
        meetings: options.meetings,
        preferences: options.settings,
        context: { tenantId: "", userId: "" },
        limits,
        registry,
        logger: request.log,
      });

      // Whatever ends the connection — a finalize, a limit, a dropped network — the user's
      // parallel-session slot has to come back, or a few dead sockets would lock them out.
      socket.on("close", () => {
        handler.dispose();
      });

      // Messages are serialized: the protocol's `persistedSeq` bookkeeping must not
      // interleave, and a chunk write must complete before the next frame is
      // handled.
      let chain: Promise<void> = options.contextProvider
        .resolve(request)
        .then((context) => {
          handler.setContext(context);
        })
        .catch((error: unknown) => {
          if (error instanceof UnauthorizedError) {
            socket.close(CLOSE_POLICY_VIOLATION, "unauthorized");
          } else {
            request.log.error({ err: error }, "failed to resolve recording context");
            socket.close(CLOSE_INTERNAL_ERROR, "failed to resolve recording context");
          }
        });

      socket.on("message", (data: Buffer, isBinary: boolean) => {
        chain = chain
          .then(() =>
            isBinary
              ? handler.handleBinary(new Uint8Array(data))
              : handler.handleText(data.toString("utf8")),
          )
          .catch((error: unknown) => {
            request.log.error({ err: error }, "recording message handling failed");
            socket.close(CLOSE_INTERNAL_ERROR, "internal error");
          });
      });
    },
  );
};

export default fp(recordingPlugin, { name: "quorum-recording", fastify: "5.x" });
