import { expect, test as base, type Page } from "@playwright/test";
import { stackEnv, type DevUser } from "./support/env.js";

export interface Fixtures {
  /** Signs a dev user in through the real Keycloak login form. */
  signIn: (user: DevUser) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  signIn: async ({ page }, use) => {
    await use(async (user: DevUser) => {
      await page.goto("/");
      await signInButton(page).click();

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
 * The landing offers the same sign-in twice — once in the header, once under the hero — so a
 * visitor who has scrolled does not have to scroll back. Both do the same thing; the specs take
 * the first one rather than each picking a different half of the page.
 */
export function signInButton(page: Page) {
  return page.getByRole("button", { name: "Sign in" }).first();
}

/**
 * The button that starts a recording. It is the consent acknowledgement as well as the start
 * control — the two are one action now, and its name says so.
 */
export function recordButton(page: Page) {
  return page.getByRole("button", {
    name: "I have informed the participants — start recording",
  });
}

/** The hold-to-stop control, which only exists while a recording is running. */
export function stopButton(page: Page) {
  return page.getByTestId("hold-to-stop");
}

/**
 * Consent, then the microphone, then capture — the order the product insists on.
 *
 * The consent notice is no longer a dialog, so there is nothing to dismiss: it is a card on the
 * start stage, and pressing the button below it is the acknowledgement. The assertion that it was
 * on screen first is the part that matters and is kept.
 */
export async function startRecording(page: Page): Promise<void> {
  await expect(page.getByTestId("consent-card")).toBeVisible();
  await expect(page.getByText("Before you record")).toBeVisible();
  await recordButton(page).click();
  await expect(stopButton(page)).toBeVisible();
}

export function captureModeButton(page: Page, mode: "in-person" | "online") {
  return page.getByTestId(`capture-mode-${mode}`);
}

export function shareAndRecordButton(page: Page) {
  return page.getByRole("button", {
    name: "I have informed the participants — share and start recording",
  });
}

/**
 * Watches what the app does with a display share, from inside the page.
 *
 * The sound-only promise is a claim about tracks, not about pixels, so it is checked where the
 * tracks are: `getDisplayMedia` is wrapped, a reference to the video track it returns is kept, and
 * the test can afterwards ask what became of that track. Chromium's fake device answers the call
 * without a picker (`--use-fake-ui-for-media-stream`) and hands back both a screen video track and
 * a synthetic audio track, which is the shape the real API returns.
 */
export async function watchDisplayCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = {
      calls: 0,
      constraints: [] as unknown[],
      videoTracks: [] as MediaStreamTrack[],
      audioTracks: [] as MediaStreamTrack[],
    };
    (window as unknown as Record<string, unknown>)["__displayCapture"] = record;

    const media = navigator.mediaDevices;
    const original = media.getDisplayMedia?.bind(media);
    if (!original) return;
    media.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
      record.calls += 1;
      record.constraints.push(constraints ?? null);
      const stream = await original(constraints);
      record.videoTracks.push(...stream.getVideoTracks());
      record.audioTracks.push(...stream.getAudioTracks());
      return stream;
    };
  });
}

/**
 * Ends the shared audio the way the browser's own "Stop sharing" control does.
 *
 * That control is browser chrome, outside the page and out of Playwright's reach, but what it does
 * to the page is exactly this: the track ends and an `ended` event fires. Driving it from here
 * tests the app's reaction, which is the part that belongs to the app.
 */
export async function stopSharing(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record = (window as unknown as Record<string, unknown>)["__displayCapture"] as
      { audioTracks: MediaStreamTrack[] } | undefined;
    for (const track of record?.audioTracks ?? []) {
      track.stop();
      track.dispatchEvent(new Event("ended"));
    }
  });
}

export async function displayCaptureReport(page: Page): Promise<{
  calls: number;
  constraints: Record<string, unknown>[];
  videoTracks: { readyState: string }[];
}> {
  return await page.evaluate(() => {
    const record = (window as unknown as Record<string, unknown>)["__displayCapture"] as
      | { calls: number; constraints: Record<string, unknown>[]; videoTracks: MediaStreamTrack[] }
      | undefined;
    return {
      calls: record?.calls ?? 0,
      constraints: record?.constraints ?? [],
      videoTracks: (record?.videoTracks ?? []).map((track) => ({ readyState: track.readyState })),
    };
  });
}

export async function startOnlineRecording(page: Page): Promise<void> {
  await expect(page.getByTestId("consent-card")).toBeVisible();
  await captureModeButton(page, "online").click();
  await expect(captureModeButton(page, "online")).toHaveAttribute("aria-checked", "true");
  await shareAndRecordButton(page).click();
  await expect(stopButton(page)).toBeVisible();
}

/**
 * The pill label is the assertion on purpose: "PAUSE" is the state the user is promised,
 * and it is what tells them the red is no longer live.
 */
export async function pauseRecording(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("PAUSE", { exact: true })).toBeVisible();
}

export async function resumeRecording(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
}

/** The recorded-time display, which counts audio and stands still through a pause. */
export function recordingTimer(page: Page) {
  return page.getByTestId("recording-timer");
}

/**
 * The persistent strip that says a recording is still running, shown on every screen except the
 * recording screen itself. It is also the way back to it.
 */
export function recordingBar(page: Page) {
  return page.getByTestId("recording-bar");
}

/**
 * Stopping is a press-and-hold: the confirmation dialog is gone and the gesture carries the
 * protection it used to.
 *
 * The mouse is held past the 1.2s the ring takes to fill — a real press, because that is the only
 * thing the button responds to. The hold is given a margin over the nominal duration so a slow CI
 * machine cannot release a tick early.
 */
export async function stopRecording(page: Page): Promise<void> {
  const button = stopButton(page);
  await button.hover();
  await page.mouse.down();
  try {
    // The hint changing is the screen confirming the hold was registered at all, so a failure
    // here says "the press never started" rather than "the recording never stopped".
    await expect(page.getByTestId("hold-to-stop-hint")).toHaveText("Keep holding…");
    await page.waitForTimeout(1600);
  } finally {
    await page.mouse.up();
  }
  await expect(button).toBeHidden();
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

export async function capturedAudioConstraints(page: Page): Promise<MediaTrackConstraints[]> {
  return await page.evaluate(
    () =>
      (window as unknown as Record<string, MediaTrackConstraints[]>)[
        "__capturedAudioConstraints"
      ] ?? [],
  );
}

/**
 * What the device is still holding for a session, read out of IndexedDB itself.
 *
 * The local buffer is half of the crash-recovery promise, and it is the half no protocol assertion
 * can see: a chunk that was written before it was sent and never acknowledged lives only here. The
 * database is opened read-only at the version the app created, so reading it cannot upgrade it or
 * block the app's own handle.
 */
export async function bufferedChunkCount(page: Page, sessionId: string): Promise<number> {
  return await page.evaluate(async (id: string) => {
    const database = await new Promise<IDBDatabase | null>((resolve) => {
      const open = indexedDB.open("quorum-recording");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    });
    if (database === null || !database.objectStoreNames.contains("chunks")) return 0;
    const store = database.transaction("chunks", "readonly").objectStore("chunks");
    // The compound key is [sessionId, seq], so one session is a bounded range over it.
    const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
    const count = await new Promise<number>((resolve) => {
      const request = store.count(range);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(0);
    });
    database.close();
    return count;
  }, sessionId);
}

export function recoveryCard(page: Page) {
  return page.getByText("A recording was interrupted");
}

/**
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
