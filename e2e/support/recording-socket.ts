import { WebSocket } from "ws";
import { bearerSubprotocolOffer } from "@quorum/shared";
import { stackEnv } from "./env.js";

/**
 * A minimal client for the recording WebSocket, used where a browser is the wrong tool: proving
 * that a token from one tenant cannot address another tenant's session. The browser tests drive
 * the real UI; this one drives the protocol.
 */

export interface CloseResult {
  code: number;
  reason: string;
}

export class RecordingSocket {
  private readonly socket: WebSocket;
  private readonly messages: unknown[] = [];
  private closed: CloseResult | null = null;
  private readonly waiters: (() => void)[] = [];

  constructor(accessToken: string) {
    const url = `${stackEnv.apiUrl.replace(/^http/, "ws")}/ws/recording`;
    this.socket = new WebSocket(url, bearerSubprotocolOffer(accessToken));
    this.socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.messages.push(JSON.parse(data.toString("utf8")));
      this.wake();
    });
    this.socket.on("close", (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString("utf8") };
      this.wake();
    });
    this.socket.on("error", () => {
      // A socket error is always followed by a close event, which carries the outcome.
    });
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private settled(): Promise<void> {
    if (this.closed !== null || this.messages.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("close", (code: number) =>
        reject(new Error(`socket closed before opening: ${code}`)),
      );
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the next server message, or null when the socket closed instead. */
  async next(timeoutMs = 10_000): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length === 0 && this.closed === null) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a server message");
      await Promise.race([this.settled(), delay(250)]);
    }
    const message = this.messages.shift();
    return message === undefined ? null : (message as Record<string, unknown>);
  }

  async closeInfo(timeoutMs = 10_000): Promise<CloseResult> {
    const deadline = Date.now() + timeoutMs;
    while (this.closed === null) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the socket to close");
      await Promise.race([this.settled(), delay(250)]);
    }
    return this.closed;
  }

  dispose(): void {
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close(1000, "test finished");
  }
}

/** Starts a session and returns its id — the cheapest way to create tenant-owned state. */
export async function startSession(accessToken: string): Promise<{
  socket: RecordingSocket;
  sessionId: string;
}> {
  const socket = new RecordingSocket(accessToken);
  await socket.open();
  socket.send({
    type: "session.start",
    meetingTitle: "cross-tenant fixture",
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    clientInfo: { platform: "e2e", userAgent: "quorum-e2e" },
  });
  const ready = await socket.next();
  if (ready?.["type"] !== "session.ready") {
    throw new Error(`expected session.ready, got ${JSON.stringify(ready)}`);
  }
  return { socket, sessionId: String(ready["sessionId"]) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
