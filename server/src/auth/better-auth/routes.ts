import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { QuorumAuth } from "./instance.js";

export interface BetterAuthRoutesOptions {
  readonly auth: QuorumAuth;
}

/**
 * Mounts better-auth's own HTTP handler under `/api/auth/*`.
 *
 * These are the endpoints that used to live in the Keycloak container: sign-up, sign-in, sign-out,
 * session read, and (once configured) reset and verification. They are `public: true` because the
 * default-deny hook would otherwise refuse the sign-in request for lack of the session it is about
 * to create.
 *
 * They are NOT exempt from the rate limiter: the limiter keys unauthenticated requests by IP, so
 * the sign-in endpoint is throttled out of the box. That is thinner than Keycloak's brute-force
 * detection (which locks the *account*, not the caller) — see the report.
 *
 * Body handling: better-auth wants a WHATWG `Request`, so the raw bytes are passed through
 * untouched rather than parsed into an object and re-serialized. The parser is registered inside
 * this encapsulated plugin, so it applies to these routes only.
 */
const betterAuthRoutes: FastifyPluginAsync<BetterAuthRoutesOptions> = async (app, options) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.route({
    method: ["GET", "POST", "OPTIONS"],
    url: "/api/auth/*",
    config: { public: true },
    handler: async (request, reply) => {
      const response = await options.auth.handler(toWebRequest(request));

      reply.status(response.status);
      for (const [name, value] of response.headers) {
        // `set-cookie` may appear several times; Headers joins them, so it is split back out.
        if (name.toLowerCase() === "set-cookie") continue;
        reply.header(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);

      return reply.send(Buffer.from(await response.arrayBuffer()));
    },
  });
};

export default betterAuthRoutes;

function toWebRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && Buffer.isBuffer(request.body);
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: request.body as Buffer } : {}),
  });
}
