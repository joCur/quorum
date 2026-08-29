import fastifyWebsocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { ServerMessage } from "@quorum/shared";
import { UnauthorizedError } from "./context-provider.js";
import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_POLICY_VIOLATION,
  RecordingSessionHandler,
} from "./session.js";
import { MAX_CHUNK_PAYLOAD_BYTES } from "./audio-format.js";
import { CHUNK_HEADER_BYTES } from "@quorum/shared";
import type { JobQueue, RecordingContextProvider, RecordingStorage } from "./types.js";

export interface RecordingPluginOptions {
  storage: RecordingStorage;
  queue: JobQueue;
  contextProvider: RecordingContextProvider;
  /** Route the WebSocket endpoint is mounted on. */
  path?: string;
  /**
   * Exempts the upgrade from the auth plugin's default-deny hook, so the context provider alone
   * decides the scope. Only the development header path sets this.
   */
  publicUpgrade?: boolean;
}

/**
 * WebSocket recording endpoint (ADR-002).
 *
 * Self-contained Fastify plugin: it registers `@fastify/websocket` itself and
 * touches no shared server state. The tenant/user scope comes from the injected
 * context provider, never from the plugin itself.
 */
const recordingPlugin: FastifyPluginAsync<RecordingPluginOptions> = async (app, options) => {
  if (!app.hasDecorator("websocketServer")) {
    await app.register(fastifyWebsocket, {
      options: { maxPayload: CHUNK_HEADER_BYTES + MAX_CHUNK_PAYLOAD_BYTES },
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
        context: { tenantId: "", userId: "" },
        logger: request.log,
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
