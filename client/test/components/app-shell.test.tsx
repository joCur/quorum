import { beforeAll, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The shell is now the same on every screen and at every width: one top bar, no sidebar, no
 * bottom tab bar, and no view excused from the frame. The rules worth pinning down are therefore
 * the ones that used to be conditional — every destination is reachable from everywhere, the
 * meeting detail included, and there is exactly one navigation landmark to reach them in.
 */
describe("app shell", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  function renderAt(route: string) {
    return renderWithProviders(
      <Routes>
        <Route path="/record" element={<p>recording screen</p>} />
        <Route element={<AppShell />}>
          <Route path="/meetings" element={<p>meetings</p>} />
          <Route path="/meetings/:meetingId" element={<p>detail</p>} />
          <Route path="/templates" element={<p>templates</p>} />
          <Route path="/settings" element={<p>settings</p>} />
        </Route>
      </Routes>,
      { route },
    );
  }

  const DETAIL = "/meetings/2f9c0f21-1b2a-4f6d-9f8e-0a1b2c3d4e5f";

  it("carries one navigation landmark with the nav pill in it", () => {
    renderAt("/meetings");
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Templates" })).toBeInTheDocument();
  });

  it("keeps settings and the record action outside the nav pill", () => {
    // They are the two ends of the bar, not destinations in the segmented pill, and both must
    // keep a name of their own — below the shell breakpoint neither shows a visible label.
    renderAt("/meetings");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
  });

  it("keeps the whole bar on the meeting detail", () => {
    // The detail used to be excused from the shell because the tab bar fought its playback bar
    // for the bottom edge. Nothing sits at that edge now, so the exception is gone; losing the
    // bar there would strand the screen users arrive at most.
    renderAt(DETAIL);
    expect(screen.getByRole("link", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Templates" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
  });

  it("names the app for assistive technology even where the wordmark is hidden", () => {
    // The wordmark is screen-reader-only below the shell breakpoint, so the name has to be text
    // rather than a styled tile that happens to look like a Q.
    renderAt("/meetings");
    expect(screen.getByText("Quorum")).toBeInTheDocument();
  });

  it("starts a recording from the record action", async () => {
    renderAt("/meetings");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(screen.getByText("recording screen")).toBeInTheDocument();
  });

  it("navigates between destinations", async () => {
    renderAt("/meetings");
    await userEvent.click(screen.getByRole("link", { name: "Templates" }));
    expect(screen.getByText("templates")).toBeInTheDocument();
  });

  it("offers a way past the navigation to the content", () => {
    renderAt("/meetings");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
  });
});
