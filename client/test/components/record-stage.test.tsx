import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import tokens from "@/styles/tokens.css?raw";
import { renderWithProviders, stubRecordingSession, useLanguage } from "./render";

/**
 * The recording screen follows the app theme like every other screen. A light-theme user gets a
 * light recording screen — the earlier "fixed dark on-air room" was reversed by the PO.
 *
 * Theme-following is a property of the stylesheet rather than of the DOM, so it is pinned from two
 * sides: the screen paints itself from the theme's own surface tokens and holds no theme-fixed
 * ground of its own, and the tokens that would have let it force one no longer exist. The on-air
 * identity has to come from the furniture instead, which is what the rest of this file asserts:
 * the REC pill and the level bars are red while capture is live and neutral when it is not.
 */

vi.mock("@/features/templates/use-templates", () => ({
  useTemplates: () => ({
    status: "ready",
    templates: [],
    error: null,
    saving: false,
    reload: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    chooseDefault: vi.fn(),
  }),
}));

const { RecordRoute } = await import("@/routes/record");

function stage(): HTMLElement {
  // The full-screen stage is the outermost element the route renders.
  const found = screen.getByTestId("consent-card").closest("div.fixed");
  if (found === null) throw new Error("the recording stage did not render");
  return found as HTMLElement;
}

function bars(): HTMLElement[] {
  return Array.from(screen.getByRole("meter").children) as HTMLElement[];
}

describe("the recording stage follows the theme", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("stands on the theme's own surface rather than a ground of its own", () => {
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession() });

    // `background`/`foreground` are exactly the tokens that flip with `.dark`, so painting with
    // them is what "follows the theme" means in a Tailwind app.
    expect(stage().className).toContain("bg-background");
    expect(stage().className).toContain("text-foreground");
  });

  it("has no theme-fixed surface left to force darkness with", () => {
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession() });

    expect(stage().className).not.toContain("on-air");
    // A hard-coded color would follow no theme at all, whichever direction it pointed.
    expect(stage().getAttribute("style")).toBeNull();
    // And the token itself is gone, so no component can quietly reintroduce the dark room.
    expect(tokens).not.toContain("--on-air");
  });
});

describe("red belongs to live capture", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("shows a red, pulsing REC pill while audio is being captured", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ state: { phase: "recording", level: 0.5 } }),
    });

    const pill = screen.getByTestId("recording-indicator");
    expect(pill).toHaveTextContent("REC");
    expect(pill.className).toContain("bg-recording");
    expect(pill.querySelector(".animate-recording-pulse")).not.toBeNull();
  });

  it("turns the pill neutral the moment capture pauses", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ state: { phase: "paused", level: 0.5 } }),
    });

    const pill = screen.getByTestId("recording-indicator");
    expect(pill).toHaveTextContent("PAUSE");
    // Nothing red is on screen while the microphone is not running — that is what makes the red
    // mean something when it is.
    expect(pill.className).not.toContain("bg-recording");
    expect(pill.querySelector(".animate-recording-pulse")).toBeNull();
  });

  it("draws the level bars in red only while live", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ state: { phase: "recording", level: 0.8 } }),
    });

    const live = bars();
    expect(live.length).toBeGreaterThan(1);
    expect(live.every((bar) => bar.className.includes("bg-recording"))).toBe(true);
    // A moving meter is the proof the microphone is picking up audio; a flat row would not be.
    expect(new Set(live.map((bar) => bar.style.height)).size).toBeGreaterThan(1);
  });

  it("freezes the bars in grey when capture is not running", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ state: { phase: "paused", level: 0.8 } }),
    });

    const paused = bars();
    expect(paused.every((bar) => bar.className.includes("bg-border"))).toBe(true);
    expect(paused.every((bar) => !bar.className.includes("bg-recording"))).toBe(true);
    // Frozen, not collapsed: bars dropping to nothing would read as a microphone that died
    // rather than one that was deliberately held.
    expect(new Set(paused.map((bar) => bar.style.height)).size).toBeGreaterThan(1);
  });
});
