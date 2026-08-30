import { expect, test as base, type Page } from "@playwright/test";
import { stackEnv, type DevUser } from "./support/env.js";

/**
 * Shared fixtures for the suite.
 *
 * Adding a critical path should mean writing a spec, not re-deriving how to sign in or how to
 * find out which session the app just created — that belongs here.
 */

export interface Fixtures {
  /** Signs a dev user in through the real Keycloak login form. */
  signIn: (user: DevUser) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  signIn: async ({ page }, use) => {
    await use(async (user: DevUser) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Sign in" }).click();

      // Keycloak's own login form — the app never sees these credentials.
      await page.waitForURL(new RegExp(`^${escapeRegExp(stackEnv.keycloakUrl)}/realms/`));
      await page.locator("#username").fill(user.username);
      await page.locator("#password").fill(user.password);
      await page.locator("#kc-login").click();

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

/** The named audio inputs the browser is made to report for the device-picker test. */
export const fakeAudioInputs = [
  { deviceId: "quorum-headset", label: "Quorum Test Headset" },
  { deviceId: "quorum-built-in", label: "Quorum Test Built-in" },
];

/**
 * Makes the browser report two named microphones and records what capture asks for.
 *
 * Chromium's fake device is a single unnamed input, which is exactly the case where the product
 * shows no picker at all — so the device list is replaced. `getUserMedia` still reaches the real
 * fake device: the constraint is captured and the device id then dropped, so the test asserts what
 * the app asked for while real audio keeps flowing through the rest of the pipeline.
 */
export async function useFakeInputDevices(page: Page): Promise<void> {
  await page.addInitScript((inputs: { deviceId: string; label: string }[]) => {
    const media = navigator.mediaDevices;
    const captured: unknown[] = [];
    (window as unknown as Record<string, unknown>)["__capturedAudioConstraints"] = captured;

    media.enumerateDevices = async () =>
      inputs.map(
        (input) =>
          ({
            ...input,
            kind: "audioinput",
            groupId: "fake",
            toJSON: () => input,
          }) as MediaDeviceInfo,
      );

    const original = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const audio = constraints?.audio;
      if (typeof audio === "object") {
        captured.push(audio);
        const { deviceId: _ignored, ...rest } = audio;
        return original({ ...constraints, audio: rest });
      }
      captured.push(audio ?? null);
      return original(constraints ?? {});
    };
  }, fakeAudioInputs);
}

/** The audio constraints every `getUserMedia` call of this page was made with, in order. */
export async function capturedAudioConstraints(page: Page): Promise<MediaTrackConstraints[]> {
  return await page.evaluate(
    () =>
      (window as unknown as Record<string, MediaTrackConstraints[]>)[
        "__capturedAudioConstraints"
      ] ?? [],
  );
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
