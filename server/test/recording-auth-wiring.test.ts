import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { ServerMessageSchema, type ServerMessage } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { JwtRecordingContextProvider } from "../src/recording/jwt-context-provider.js";
import { UnauthorizedError } from "../src/recording/context-provider.js";
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
});

async function startAuthenticatedServer(
  storage: InMemoryRecordingStorage,
  queue: InMemoryJobQueue,
) {
  app = await buildServer({
    storage,
    queue,
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

/**
 * Opens a WebSocket that is expected to be refused during the HTTP upgrade and returns the status
 * code the server answered with. The underlying socket is destroyed so the server can close.
 */
async function rejectedUpgradeStatus(
  url: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const socket = new WebSocket(url, { headers });
  try {
    return await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
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

describe("JwtRecordingContextProvider", () => {
  it("takes the scope from the authenticated request context", async () => {
    const provider = new JwtRecordingContextProvider();
    const context = await provider.resolve({
      headers: { "x-quorum-tenant-id": "tenant-spoofed", "x-quorum-user-id": "user-spoofed" },
      auth: { tenantId: "tenant-acme", userId: "user-42" },
    });
    expect(context).toEqual({ tenantId: "tenant-acme", userId: "user-42" });
  });

  it("ignores the development headers entirely", async () => {
    const provider = new JwtRecordingContextProvider();
    await expect(
      provider.resolve({
        headers: { "x-quorum-tenant-id": "tenant-spoofed", "x-quorum-user-id": "user-spoofed" },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("recording endpoint on an authenticated server", () => {
  it("refuses the upgrade without an access token", async () => {
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    expect(await rejectedUpgradeStatus(`ws://127.0.0.1:${port}/ws/recording`)).toBe(401);
  });

  it("refuses the upgrade when only the development headers are present", async () => {
    const port = await startAuthenticatedServer(
      new InMemoryRecordingStorage(),
      new InMemoryJobQueue(),
    );
    const status = await rejectedUpgradeStatus(`ws://127.0.0.1:${port}/ws/recording`, {
      "x-quorum-tenant-id": "tenant-acme",
      "x-quorum-user-id": "user-42",
    });
    expect(status).toBe(401);
  });

  it("scopes the session to the tenant and user from the token", async () => {
    const storage = new InMemoryRecordingStorage();
    const queue = new InMemoryJobQueue();
    const port = await startAuthenticatedServer(storage, queue);

    const token = await signAccessToken(keys, {
      issuer: ISSUER,
      subject: "user-42",
      tenantId: "tenant-acme",
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/recording`, {
      // The tenant headers a client could forge are deliberately wrong here.
      headers: {
        authorization: `Bearer ${token}`,
        "x-quorum-tenant-id": "tenant-spoofed",
        "x-quorum-user-id": "user-spoofed",
      },
    });

    const messages: ServerMessage[] = [];
    socket.on("message", (data: Buffer) => {
      messages.push(ServerMessageSchema.parse(JSON.parse(data.toString("utf8"))));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        resolve();
      });
      socket.once("error", reject);
    });

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
    expect(record).not.toBeNull();
    expect(record?.tenantId).toBe("tenant-acme");
    expect(record?.userId).toBe("user-42");
    expect(await storage.getSession("tenant-spoofed", "user-spoofed", ready.sessionId)).toBeNull();

    socket.close();
  });
});
