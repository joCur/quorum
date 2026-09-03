import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockReload, isReloadUnsafe, resetReloadGuard } from "@/features/pwa/reload-guard";
import {
  ACTIVATION_GRACE_MS,
  RELOAD_RETRY_MS,
  applyUpdate,
  startUpdateWatch,
} from "@/features/pwa/update-watch";
import { useAppUpdate, type AppUpdateOptions } from "@/features/pwa/use-app-update";
import { AppUpdateBanner } from "@/components/app-update-banner";
import i18n from "@/i18n";
import { useLanguage } from "./render";

/**
 * A registration that behaves like the browser's: `update()` is what pulls a new worker in, and
 * whether one is parked in `waiting` afterwards is what the app reads.
 */
function stubRegistration(options: { waiting?: boolean; onUpdate?: () => void } = {}) {
  const registration = {
    waiting: options.waiting ? ({} as ServiceWorker) : null,
    update: vi.fn(async () => {
      options.onUpdate?.();
    }),
  };
  return registration;
}

/** A worker whose state the test drives, firing `statechange` the way the browser does. */
function stubWorker(state: ServiceWorkerState) {
  const listeners = new Set<EventListener>();
  return {
    state,
    addEventListener(_type: string, listener: EventListener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: EventListener) {
      listeners.delete(listener);
    },
    moveTo(next: ServiceWorkerState) {
      this.state = next;
      for (const listener of [...listeners]) listener(new Event("statechange"));
    },
  };
}

function stubContainer(registration: unknown | null, options: { controlled?: boolean } = {}) {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    controller: options.controlled === false ? null : ({} as ServiceWorker),
    getRegistration: vi.fn(async () => registration ?? undefined),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    /** Test-only: fires what the browser would fire when a new worker takes over. */
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener(new Event(type));
    },
  } as unknown as ServiceWorkerContainer & { emit: (type: string) => void };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  resetReloadGuard();
  setVisibility("visible");
  vi.useRealTimers();
});

describe("reload guard", () => {
  it("is safe until something claims otherwise, and safe again when the claim is released", () => {
    expect(isReloadUnsafe()).toBe(false);
    const release = blockReload("recording");
    expect(isReloadUnsafe()).toBe(true);
    release();
    expect(isReloadUnsafe()).toBe(false);
  });

  it("stays unsafe while any one of several claims is outstanding", () => {
    const first = blockReload("recording");
    const second = blockReload("upload");
    first();
    expect(isReloadUnsafe()).toBe(true);
    second();
    expect(isReloadUnsafe()).toBe(false);
  });
});

describe("applyUpdate", () => {
  it("reloads once when no worker is parked", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    await applyUpdate(stubContainer(stubRegistration()), reload);
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY_MS * 2);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  /**
   * The reload is what releases a parked worker, so it happens while the outgoing worker is being
   * discarded and the navigation it was handed is never answered. The document outlives that dead
   * navigation, which is the only reason it can still ask for another one.
   */
  it("reloads a second time when the reload releases a parked worker", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    await applyUpdate(stubContainer(stubRegistration({ waiting: true })), reload);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY_MS + 1);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("still reloads where the browser has no service worker", async () => {
    const reload = vi.fn();
    await applyUpdate(null, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("startUpdateWatch", () => {
  const version = "1.2.3";

  it("reports the worker that was already parked in waiting", async () => {
    const onUpdateReady = vi.fn();
    const watch = startUpdateWatch({
      container: stubContainer(stubRegistration({ waiting: true })),
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady,
    });
    await watch.check();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("reports a worker that only appears once update() has run", async () => {
    const onUpdateReady = vi.fn();
    const registration = stubRegistration();
    const worker = stubWorker("installed");
    registration.update = vi.fn(async () => {
      registration.waiting = worker as unknown as ServiceWorker;
    });
    const watch = startUpdateWatch({
      container: stubContainer(registration),
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady,
    });
    const settled = watch.check();
    worker.moveTo("activated");
    await settled;
    expect(registration.update).toHaveBeenCalled();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("reports a version skew even where the browser has no service worker at all", async () => {
    const onUpdateReady = vi.fn();
    const watch = startUpdateWatch({
      container: null,
      runningVersion: version,
      readDeployedVersion: async () => "1.3.0",
      onUpdateReady,
    });
    await watch.check();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("stays quiet when the deployment matches and nothing is waiting", async () => {
    const onUpdateReady = vi.fn();
    const watch = startUpdateWatch({
      container: stubContainer(stubRegistration()),
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady,
    });
    await watch.check();
    expect(onUpdateReady).not.toHaveBeenCalled();
    watch.stop();
  });

  it("stays quiet when the version marker cannot be read", async () => {
    const onUpdateReady = vi.fn();
    const watch = startUpdateWatch({
      container: null,
      runningVersion: version,
      readDeployedVersion: async () => {
        throw new Error("offline");
      },
      onUpdateReady,
    });
    await watch.check();
    expect(onUpdateReady).not.toHaveBeenCalled();
    watch.stop();
  });

  it("announces once, however many signals and checks agree", async () => {
    const onUpdateReady = vi.fn();
    const watch = startUpdateWatch({
      container: stubContainer(stubRegistration({ waiting: true })),
      runningVersion: version,
      readDeployedVersion: async () => "9.9.9",
      onUpdateReady,
    });
    await watch.check();
    await watch.check();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("waits for a downloading worker to activate before announcing", async () => {
    const order: string[] = [];
    const installing = {
      state: "installing" as ServiceWorkerState,
      listeners: new Set<EventListener>(),
      addEventListener(_type: string, listener: EventListener) {
        this.listeners.add(listener);
      },
      removeEventListener(_type: string, listener: EventListener) {
        this.listeners.delete(listener);
      },
      activate() {
        this.state = "activated";
        for (const listener of this.listeners) listener(new Event("statechange"));
      },
    };
    const registration = {
      waiting: null as ServiceWorker | null,
      installing: installing as unknown as ServiceWorker,
      update: vi.fn(async () => {
        order.push("update");
      }),
    };
    const watch = startUpdateWatch({
      container: stubContainer(registration),
      runningVersion: version,
      readDeployedVersion: async () => {
        order.push("version");
        return "2.0.0";
      },
      onUpdateReady: () => order.push("announce"),
    });

    const settled = watch.check();
    await Promise.resolve();
    await Promise.resolve();
    // The version marker is the quicker answer, but it must not be read — let alone announced —
    // while the worker carrying the new shell is still installing.
    expect(order).not.toContain("version");
    expect(order).not.toContain("announce");

    installing.activate();
    await settled;
    expect(order).toContain("version");
    expect(order.indexOf("announce")).toBeGreaterThan(order.indexOf("version"));
    watch.stop();
  });

  /**
   * A worker that has finished installing is a fraction of a second away from taking over, and a
   * request sent from this page in that window is dispatched to the worker on its way out. That
   * restarts it, the browser abandons the handover, and the new worker is left in `waiting` where
   * only closing every tab releases it — after which the next reload wedges the tab outright.
   */
  it("does not read the version marker while the new worker is taking over", async () => {
    const order: string[] = [];
    const worker = stubWorker("installing");
    const registration = {
      waiting: null as ServiceWorker | null,
      installing: worker as unknown as ServiceWorker,
      update: vi.fn(async () => undefined),
    };
    const watch = startUpdateWatch({
      container: stubContainer(registration),
      runningVersion: version,
      readDeployedVersion: async () => {
        order.push("version");
        return version;
      },
      onUpdateReady: () => order.push("announce"),
    });

    const settled = watch.check();
    worker.moveTo("installed");
    await Promise.resolve();
    await Promise.resolve();
    expect(order).not.toContain("version");

    worker.moveTo("activated");
    await settled;
    expect(order).toContain("version");
    watch.stop();
  });

  it("gives up on a worker that parks in waiting instead of hanging the check", async () => {
    vi.useFakeTimers();
    const worker = stubWorker("installing");
    const registration = {
      waiting: null as ServiceWorker | null,
      installing: worker as unknown as ServiceWorker,
      update: vi.fn(async () => undefined),
    };
    const onUpdateReady = vi.fn();
    const watch = startUpdateWatch({
      container: stubContainer(registration),
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady,
    });

    const settled = watch.check();
    await vi.advanceTimersByTimeAsync(0);
    worker.moveTo("installed");
    registration.waiting = worker as unknown as ServiceWorker;
    await vi.advanceTimersByTimeAsync(ACTIVATION_GRACE_MS + 1);
    await settled;
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.stop();
    vi.useRealTimers();
  });

  it("announces when the new worker takes control", async () => {
    const onUpdateReady = vi.fn();
    const container = stubContainer(stubRegistration());
    const watch = startUpdateWatch({
      container,
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady,
    });
    await watch.check();
    expect(onUpdateReady).not.toHaveBeenCalled();
    container.emit("controllerchange");
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("does not mistake the first worker claiming an uncontrolled page for an update", async () => {
    const onUpdateReady = vi.fn();
    const container = stubContainer(stubRegistration(), { controlled: false });
    const watch = startUpdateWatch({
      container,
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady,
    });
    await watch.check();
    container.emit("controllerchange");
    expect(onUpdateReady).not.toHaveBeenCalled();
    watch.stop();
  });

  it("checks again on the interval, and detaches everything on stop", async () => {
    vi.useFakeTimers();
    const registration = stubRegistration();
    const watch = startUpdateWatch({
      container: stubContainer(registration),
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady: vi.fn(),
      checkIntervalMs: 1000,
      minCheckSpacingMs: 0,
    });
    await vi.advanceTimersByTimeAsync(3500);
    const duringWatch = registration.update.mock.calls.length;
    expect(duringWatch).toBeGreaterThanOrEqual(3);
    watch.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(registration.update.mock.calls.length).toBe(duringWatch);
  });

  it("checks when the tab comes back to the foreground, but not more often than the floor", async () => {
    vi.useFakeTimers();
    const registration = stubRegistration();
    const watch = startUpdateWatch({
      container: stubContainer(registration),
      runningVersion: version,
      readDeployedVersion: async () => version,
      onUpdateReady: vi.fn(),
      checkIntervalMs: 10 * 60 * 1000,
      minCheckSpacingMs: 60 * 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const afterStartup = registration.update.mock.calls.length;

    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(registration.update.mock.calls.length).toBe(afterStartup);

    await vi.advanceTimersByTimeAsync(61 * 1000);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(registration.update.mock.calls.length).toBeGreaterThan(afterStartup);
    watch.stop();
  });
});

/** Renders the hook's result as text, so the surrounding assertions read like the UI does. */
function UpdateProbe(options: AppUpdateOptions) {
  const update = useAppUpdate(options);
  return (
    <div>
      <span data-testid="available">{String(update.available)}</span>
      <span data-testid="blocked">{String(update.blocked)}</span>
    </div>
  );
}

describe("useAppUpdate", () => {
  const base = (overrides: Partial<AppUpdateOptions> = {}): AppUpdateOptions => ({
    container: null,
    runningVersion: "1.0.0",
    readVersion: async () => "2.0.0",
    checkIntervalMs: 60_000,
    minCheckSpacingMs: 60_000,
    ...overrides,
  });

  it("surfaces an available update", async () => {
    render(<UpdateProbe {...base()} />);
    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("true"));
  });

  it("reports itself blocked while a recording holds the guard", async () => {
    blockReload("recording");
    render(<UpdateProbe {...base()} />);
    await waitFor(() => expect(screen.getByTestId("blocked")).toHaveTextContent("true"));
  });

  it("unblocks as soon as the recording releases the guard", async () => {
    const release = blockReload("recording");
    render(<UpdateProbe {...base()} />);
    await waitFor(() => expect(screen.getByTestId("blocked")).toHaveTextContent("true"));
    act(() => release());
    await waitFor(() => expect(screen.getByTestId("blocked")).toHaveTextContent("false"));
  });

  /** Renders the probe and runs time past the deadline, so the update is expired and unanswered. */
  async function renderExpired(reload: () => void) {
    vi.useFakeTimers();
    render(<UpdateProbe {...base({ deadlineMs: 1000, reload })} />);
    // Two advances, each inside `act`. The first lets the version check resolve; only when `act`
    // flushes that state update does the effect that arms the deadline timer run, so the second
    // advance is what runs that timer out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
  }

  it("does not reload past the deadline while the user is looking at the tab", async () => {
    const reload = vi.fn();
    await renderExpired(reload);
    expect(reload).not.toHaveBeenCalled();
  });

  it("applies itself past the deadline once the tab is in the background", async () => {
    const reload = vi.fn();
    await renderExpired(reload);
    expect(reload).not.toHaveBeenCalled();
    setVisibility("hidden");
    // Applying now asks the browser whether a worker is parked before it navigates, so the reload
    // lands a microtask later than the event that asked for it.
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalled();
  });

  it("never reloads a backgrounded tab that is still recording", async () => {
    const reload = vi.fn();
    const release = blockReload("recording");
    await renderExpired(reload);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).not.toHaveBeenCalled();

    // …and catches up once the recording ends with the tab still in the background.
    act(() => release());
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalled();
  });

  it("applies the update through the reload it was given", async () => {
    const reload = vi.fn();
    function ApplyProbe() {
      const { available, apply } = useAppUpdate(base({ reload }));
      return available ? <button onClick={apply}>apply</button> : null;
    }
    render(<ApplyProbe />);
    await userEvent.click(await screen.findByRole("button", { name: "apply" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

/**
 * The banner takes no props — it is the app's one wiring point — so it is driven the way the
 * browser drives it: through the version marker it fetches and the reload guard it reads.
 */
function renderBanner() {
  return render(
    <I18nextProvider i18n={i18n}>
      <AppUpdateBanner />
    </I18nextProvider>,
  );
}

describe("AppUpdateBanner", () => {
  beforeEach(async () => {
    await useLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** `__APP_VERSION__` is "0.0.0-test" under the component suite (see setup.ts). */
  function serveVersion(version: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 })),
    );
  }

  it("says nothing while the deployed version is the one running", async () => {
    serveVersion("0.0.0-test");
    renderBanner();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // The click itself is covered by the hook, which takes its reload as an argument. jsdom's
  // `location.reload` cannot be replaced, so the banner is held to what it owns: the copy and
  // the presence of the offer.
  it("offers a reload once the deployment has moved on", async () => {
    serveVersion("0.0.1-test");
    renderBanner();

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("A new version of Quorum is available.");
    expect(screen.getByRole("button", { name: "Reload now" })).toBeInTheDocument();
  });

  it("withholds the reload button while a recording is running", async () => {
    serveVersion("0.0.1-test");
    blockReload("recording");
    renderBanner();

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("once the recording is finished");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the reload the moment the recording ends", async () => {
    serveVersion("0.0.1-test");
    const release = blockReload("recording");
    renderBanner();
    await screen.findByRole("status");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    act(() => release());
    expect(await screen.findByRole("button", { name: "Reload now" })).toBeInTheDocument();
  });

  it("speaks German too", async () => {
    await useLanguage("de");
    serveVersion("0.0.1-test");
    renderBanner();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Eine neue Version von Quorum ist verfügbar.",
    );
    expect(screen.getByRole("button", { name: "Jetzt neu laden" })).toBeInTheDocument();
    await useLanguage("en");
  });
});
