import { expect, test as base, type Page } from "@playwright/test";
import { type DevUser } from "./support/env.js";

/**
 * Shared fixtures for the suite.
 *
 * Adding a critical path should mean writing a spec, not re-deriving how to sign in or how to
 * find out which session the app just created — that belongs here.
 */

export interface Fixtures {
  /** Signs a dev user in through the app's own login form. */
  signIn: (user: DevUser) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  signIn: async ({ page }, use) => {
    await use(async (user: DevUser) => {
      // SPIKE: no redirect to a provider and back — the form is part of the app, so signing in is
      // three interactions on one page. The suite no longer has to know the identity provider's
      // DOM (`#username`, `#kc-login`), which was the most brittle thing in this file.
      await page.goto("/login");
      await page.getByLabel("Email").fill(user.email);
      await page.getByLabel("Password").fill(user.password);
      await page.getByRole("button", { name: "Sign in" }).click();

      await page.waitForURL(/\/meetings$/);
      await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();
    });
  },
});

export { expect } from "@playwright/test";

/**
 * The record control, which is also the stop control: it carries `aria-pressed` while a recording
 * is running, which is the one attribute that tells the two states apart without guessing.
 */
export function recordButton(page: Page) {
  return page.getByRole("button", { name: "Record", exact: true });
}

export function stopButton(page: Page) {
  return page.locator('button[aria-pressed="true"]');
}

/** Consent, then the microphone, then capture — the order the product insists on. */
export async function startRecording(page: Page): Promise<void> {
  await recordButton(page).click();
  await expect(page.getByText("Before you record")).toBeVisible();
  await page.getByRole("button", { name: "I have informed the participants" }).click();
  await expect(stopButton(page)).toBeVisible();
}

/**
 * Pauses a running recording and waits until the screen says so.
 *
 * The indicator label is the assertion on purpose: "PAUSED" is the state the user is promised,
 * and it is what tells them the red is no longer live.
 */
export async function pauseRecording(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("PAUSED", { exact: true })).toBeVisible();
}

export async function resumeRecording(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
}

/** The recorded-time display, which counts audio and stands still through a pause. */
export function recordingTimer(page: Page) {
  return page.getByTestId("recording-timer");
}

/** Stopping is a two-step confirmation; the second "Stop" lives in the confirmation panel. */
export async function stopRecording(page: Page): Promise<void> {
  await stopButton(page).click();
  const panel = page
    .locator("div")
    .filter({ has: page.getByText("Stop recording?") })
    .last();
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
}

/**
 * Watches the recording WebSocket and reports what the protocol actually did.
 *
 * The session id never appears in the DOM, but every storage assertion needs it. Reading it off
 * the wire keeps the tests honest: they assert against the session the app really opened.
 */
export function watchRecordingProtocol(page: Page): RecordingProtocolWatcher {
  const watcher = new RecordingProtocolWatcher();
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/recording")) return;
    socket.on("framereceived", (frame) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(frame.payload as string) as Record<string, unknown>;
      } catch {
        return;
      }
      watcher.accept(message);
    });
  });
  return watcher;
}

export class RecordingProtocolWatcher {
  private sessionIdValue: string | null = null;
  private meetingIdValue: string | null = null;
  private persistedSeqValue = -1;
  private finalizedValue = false;

  accept(message: Record<string, unknown>): void {
    switch (message["type"]) {
      case "session.ready":
        this.sessionIdValue = String(message["sessionId"]);
        return;
      case "chunk.ack": {
        const seq = Number(message["persistedSeq"]);
        if (seq > this.persistedSeqValue) this.persistedSeqValue = seq;
        return;
      }
      case "session.finalized":
        this.finalizedValue = true;
        this.meetingIdValue = String(message["meetingId"]);
        return;
      default:
        return;
    }
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  get meetingId(): string | null {
    return this.meetingIdValue;
  }

  /** Highest sequence number the server confirmed as persisted. */
  get persistedSeq(): number {
    return this.persistedSeqValue;
  }

  get finalized(): boolean {
    return this.finalizedValue;
  }

  async waitForSessionId(timeoutMs = 20_000): Promise<string> {
    await waitFor(() => this.sessionIdValue !== null, timeoutMs, "session.ready");
    return this.sessionIdValue as string;
  }

  async waitForAck(seq: number, timeoutMs = 30_000): Promise<void> {
    await waitFor(() => this.persistedSeqValue >= seq, timeoutMs, `chunk.ack for seq ${seq}`);
  }

  async waitForFinalized(timeoutMs = 30_000): Promise<void> {
    await waitFor(() => this.finalizedValue, timeoutMs, "session.finalized");
  }
}

/** Polls a condition; the suite talks to four processes, so polling is the honest primitive. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Polls until the producer returns a value, then hands it back. */
export async function waitForValue<T>(
  produce: () => Promise<T | null>,
  timeoutMs: number,
  what: string,
  intervalMs = 500,
): Promise<T> {
  let value: T | null = null;
  await waitFor(
    async () => {
      value = await produce();
      return value !== null;
    },
    timeoutMs,
    what,
    intervalMs,
  );
  return value as T;
}
