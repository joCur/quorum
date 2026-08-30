import { beforeAll, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The shell decides what navigation is on screen, and it decides it from the route. That makes it
 * exactly the kind of conditional that breaks quietly: a changed path pattern still renders a
 * perfectly good app, just with the tab bar sitting on top of the meeting detail's playback bar
 * on every small screen.
 */
describe("app shell navigation", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  function renderAt(route: string) {
    return renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/meetings" element={<p>meetings</p>} />
          <Route path="/meetings/:meetingId" element={<p>detail</p>} />
          <Route path="/templates" element={<p>templates</p>} />
        </Route>
      </Routes>,
      { route },
    );
  }

  /**
   * The sidebar and the tab bar carry the same landmark label, so they are told apart by the
   * record control: only the tab bar has the raised icon-only button.
   */
  function tabBarPresent(): boolean {
    return screen.getAllByRole("navigation").some((nav) => nav.className.includes("fixed"));
  }

  it("shows the tab bar on a list screen", () => {
    renderAt("/meetings");
    expect(tabBarPresent()).toBe(true);
  });

  it("hides the tab bar on the meeting detail", () => {
    renderAt("/meetings/2f9c0f21-1b2a-4f6d-9f8e-0a1b2c3d4e5f");
    // The detail is a leaf view: it owns the bottom of a small screen with its playback bar and
    // carries its own way back, so the tab bar and its record button step aside.
    expect(tabBarPresent()).toBe(false);
  });

  it("shows the tab bar again on a sibling screen", () => {
    renderAt("/templates");
    expect(tabBarPresent()).toBe(true);
  });

  it("keeps the sidebar on every route, detail included", () => {
    // Above `md` the sidebar never competes for the bottom edge, so the leaf-view rule does not
    // apply to it. Removing it on the detail would be the obvious wrong fix for the same bug.
    renderAt("/meetings/2f9c0f21-1b2a-4f6d-9f8e-0a1b2c3d4e5f");
    const sidebar = screen
      .getAllByRole("navigation")
      .find((nav) => !nav.className.includes("fixed"));
    expect(sidebar).toBeDefined();
    expect(screen.getByRole("link", { name: "Meetings" })).toBeInTheDocument();
  });

  it("offers a way past the navigation to the content", () => {
    renderAt("/meetings");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
  });
});
