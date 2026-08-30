import { createServer, type Server } from "node:http";
import type { WorkerMetrics } from "./metrics.js";

export interface MetricsServerOptions {
  metrics: WorkerMetrics;
  port: number;
  host?: string;
}

export interface MetricsServer {
  readonly server: Server;
  /** Port actually bound; differs from the requested one when that was 0. */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Minimal HTTP surface for the worker: `GET /metrics` and `GET /healthz`.
 *
 * The worker is a queue consumer with no HTTP server of its own, and it is the
 * only process that knows how long its jobs took. A plain `node:http` listener
 * is the whole cost of making that scrapeable — pulling Fastify into the worker
 * to serve two static routes would be the larger change.
 *
 * `/healthz` is here as a side effect worth having: until now a wedged worker
 * container looked healthy to Docker, because nothing could ask it anything.
 */
export async function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const { metrics } = options;

  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];

    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return;
    }

    if (path === "/healthz") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ status: "ok", service: "quorum-worker" }));
      return;
    }

    if (path !== "/metrics") {
      response.writeHead(404).end();
      return;
    }

    void metrics
      .render()
      .then((body) => {
        response.writeHead(200, { "content-type": metrics.contentType }).end(body);
      })
      .catch(() => {
        // A failed render must not take the process down; the scrape fails and
        // Prometheus marks the target down, which is the correct signal.
        response.writeHead(500).end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    server,
    port,
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
