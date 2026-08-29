import Fastify, { type FastifyInstance } from "fastify";
import recordingPlugin from "./recording/plugin.js";
import type { JobQueue, RecordingContextProvider, RecordingStorage } from "./recording/types.js";

export interface BuildServerOptions {
  storage: RecordingStorage;
  queue: JobQueue;
  contextProvider: RecordingContextProvider;
  logger?: boolean | { level: string };
}

/**
 * Minimal application bootstrap.
 *
 * Deliberately thin: ticket #3 scaffolds the full server (auth plugin, REST
 * routes, error handling). This file is expected to be merged with that version;
 * the only line that must survive is the `recordingPlugin` registration.
 */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(recordingPlugin, {
    storage: options.storage,
    queue: options.queue,
    contextProvider: options.contextProvider,
  });

  return app;
}
