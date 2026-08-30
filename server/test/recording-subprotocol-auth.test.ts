import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { ServerMessageSchema, type ServerMessage } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { BEARER_SUBPROTOCOL } from "../src/auth/subprotocol.js";
import { bearerSubprotocolOffer } from "@quorum/shared";
import { createTestAuth } from "./sessions.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { WEBM_OPUS } from "./helpers.js";

const fixture = await createTestAuth();

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  vi.restoreAllMocks();
});

async function startAuthenticatedServer(
  storage: InMemoryRecordingStorage,
  queue: InMemoryJobQueue,
  logger: boolean | { level: string } = false,
): Promise<number> {
  app = await buildServer({
    storage,
    queue,
    logger,
    auth: {
      verifyAccessToken: fixture.verify,
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a port");
  return address.port;
}

/** Opens the recording socket the way the browser client does: marker first, then the token. */
function openWithSubprotocol(port: number, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/recording`, bearerSubprotocolOffer(token));
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
}

/**
 * Opens a WebSocket that is expected to be refused during the HTTP upgrade and returns the status
 * code the server answered with, together with the raw response body.
 */
async function rejectedUpgrade(
  port: number,
  protocols: string[],
): Promise<{ status: number; body: string }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/recording`, protocols);
  try {
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      });
      socket.once("open", () => {
        reject(new Error("the upgrade was accepted but should have been refused"));
      });
      socket.once("error", reject);
    });
  } finally {
    socket.terminate();
  }
}

describe("recording upgrade authenticated via the bearer subprotocol", () => {
  it("accepts a valid token and scopes the session to its tenant and user", async () => {
    const storage = new InMemoryRecordingStorage();
    const queue = new InMemoryJobQueue();
    const port = await startAuthenticatedServer(storage, queue);

    const token = await fixture.issueSessionToken({
      subject: "user-42",
      tenantId: "tenant-acme",
    });
    const socket = openWithSubprotocol(port, token);

    const messages: ServerMessage[] = [];
    socket.on("message", (data: Buffer) => {
      messages.push(ServerMessageSchema.parse(JSON.parse(data.toString("utf8"))));
    });
    await waitForOpen(socket);

    // RFC 6455: the handshake echoes the marker, and never the token itself.
    expect(socket.protocol).toBe(BEARER_SUBPROTOCOL);

    socket.send(
      JSON.stringify({
        type: "session.start",
        meetingTitle: "Weekly sync",
        audioFormat: WEBM_OPUS,
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );

    const deadline = Date.now() + 2000;
    let ready: Extract<ServerMessage, { type: "session.ready" }> | undefined;
    while (ready === undefined) {
      ready = messages.find((message) => message.type === "session.ready");
      if (Date.now() > deadline) throw new Error("timed out waiting for session.ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const record = await storage.getSession("tenant-acme", "user-42", ready.sessionId);
    expect(record?.tenantId).toBe("tenant-acme");
    expect(record?.userId).toBe("user-42");
    expect(await storage.getSession("tenant-other", "user-42", ready.sessionId)).toBeNull();

    socket.close();
  });

  it("prefers the Authorization header when both channels are present", async () => {
    const storage = new InMemoryRecordingStorage();
    const port = await startAuthenticatedServer(storage, new InMemoryJobQueue());

    const headerToken = await fixture.issueSessionToken({
      subject: "user-42",
      tenantId: "tenant-acme",
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/recording`,
      bearerSubprotocolOffer("not.a.token"),
      { headers: { authorization: `Bearer ${headerToken}` } },
    );

    await waitForOpen(socket);
    expect(socket.protocol).toBe(BEARER_SUBPROTOCOL);
    socket.close();
  });

  it("refuses a forged token", async () => {
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    // Forgery in this world is not "signed by the wrong key" — there is no signature to forge.
    // An attacker's only move is to present a session identifier that is not in the store.
    const forged = "0123456789abcdef.0123456789abcdef";
    const { status, body } = await rejectedUpgrade(port, bearerSubprotocolOffer(forged));
    expect(status).toBe(401);
    expect(body).toContain("invalid_token");
  });

  it("refuses a token whose session was revoked", async () => {
    // SPIKE: this replaces "refuses an expired token". A self-contained JWT could be handed to the
    // suite already expired; an opaque session token cannot be aged on demand, so the equivalent —
    // and stronger — assertion is that a session which has been ended stops working immediately.
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    const token = await fixture.issueSessionToken({
      subject: "user-revoked",
      username: "dev.revoked",
      tenantId: "tenant-acme",
    });
    await fixture.revokeSessions("user-revoked");

    const { status, body } = await rejectedUpgrade(port, bearerSubprotocolOffer(token));
    expect(status).toBe(401);
    expect(body).toContain("invalid_token");
  });

  it("refuses a marker that carries no token", async () => {
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    const { status, body } = await rejectedUpgrade(port, [BEARER_SUBPROTOCOL]);
    expect(status).toBe(401);
    expect(body).toContain("malformed_bearer_subprotocol");
  });

  it("refuses an upgrade offering an unrelated subprotocol", async () => {
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    const { status, body } = await rejectedUpgrade(port, ["some.other.protocol"]);
    expect(status).toBe(401);
    expect(body).toContain("missing_token");
  });

  it("tears the refused socket down so shutdown does not hang", async () => {
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    expect((await rejectedUpgrade(port, bearerSubprotocolOffer("not.a.token"))).status).toBe(401);

    const instance = app;
    app = null;
    const closed = await Promise.race([
      instance?.close().then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 2000)),
    ]);
    expect(closed).toBe("closed");
  });

  it("never writes the token to the log", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
      { level: "trace" },
    );

    const valid = await fixture.issueSessionToken({
      subject: "user-logging",
      username: "dev.logging",
      tenantId: "tenant-acme",
    });
    const socket = openWithSubprotocol(port, valid);
    await waitForOpen(socket);
    socket.close();

    const rejected = "forged.but.unique-token-value";
    expect((await rejectedUpgrade(port, bearerSubprotocolOffer(rejected))).status).toBe(401);

    const log = written.join("");
    // Positive control: the assertions below are only meaningful if logging actually happened.
    expect(log).toContain("rejected request without a valid access token");
    expect(log).not.toContain(valid);
    expect(log).not.toContain(rejected);
  });
});
