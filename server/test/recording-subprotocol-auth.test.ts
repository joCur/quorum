import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { ServerMessageSchema, type ServerMessage } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { BEARER_SUBPROTOCOL } from "../src/auth/subprotocol.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { AUDIENCE, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";
import { WEBM_OPUS } from "./helpers.js";

const keys: TestKeyPair = await createTestKeyPair();

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
      verifyAccessToken: createTokenVerifier({
        issuers: [ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: keys.jwks,
      }),
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a port");
  return address.port;
}

/** Opens the recording socket the way the browser client does: marker first, then the token. */
function openWithSubprotocol(port: number, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/recording`, [BEARER_SUBPROTOCOL, token]);
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

    const token = await signAccessToken(keys, {
      issuer: ISSUER,
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

    const headerToken = await signAccessToken(keys, {
      issuer: ISSUER,
      subject: "user-42",
      tenantId: "tenant-acme",
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/recording`,
      [BEARER_SUBPROTOCOL, "not.a.token"],
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
    const forged = await signAccessToken(await createTestKeyPair("other-key"), {
      issuer: ISSUER,
      subject: "user-42",
    });
    const { status, body } = await rejectedUpgrade(port, [BEARER_SUBPROTOCOL, forged]);
    expect(status).toBe(401);
    expect(body).toContain("invalid_token");
  });

  it("refuses an expired token", async () => {
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    const now = Math.floor(Date.now() / 1000);
    const expired = await signAccessToken(keys, {
      issuer: ISSUER,
      issuedAt: now - 3600,
      expiresAt: now - 1800,
    });
    const { status, body } = await rejectedUpgrade(port, [BEARER_SUBPROTOCOL, expired]);
    expect(status).toBe(401);
    expect(body).toContain("expired_token");
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
    expect((await rejectedUpgrade(port, [BEARER_SUBPROTOCOL, "not.a.token"])).status).toBe(401);

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

    const valid = await signAccessToken(keys, { issuer: ISSUER, tenantId: "tenant-acme" });
    const socket = openWithSubprotocol(port, valid);
    await waitForOpen(socket);
    socket.close();

    const rejected = "forged.but.unique-token-value";
    expect((await rejectedUpgrade(port, [BEARER_SUBPROTOCOL, rejected])).status).toBe(401);

    const log = written.join("");
    // Positive control: the assertions below are only meaningful if logging actually happened.
    expect(log).toContain("rejected request without a valid access token");
    expect(log).not.toContain(valid);
    expect(log).not.toContain(rejected);
  });
});
