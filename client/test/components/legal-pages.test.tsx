import { beforeAll, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { LegalPlaceholderRoute, LEGAL_PATHS } from "@/routes/legal";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The imprint and the privacy statement.
 *
 * Their text is a ticket of its own — legal pages are not something to improvise — so what these
 * check is the part that matters until then: the footer's links lead somewhere real, the page says
 * plainly that the text is still to come, and a visitor without an account can read it.
 */
describe("the legal pages", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  function renderAt(route: string) {
    return renderWithProviders(
      <Routes>
        <Route path={LEGAL_PATHS.imprint} element={<LegalPlaceholderRoute page="imprint" />} />
        <Route path={LEGAL_PATHS.privacy} element={<LegalPlaceholderRoute page="privacy" />} />
      </Routes>,
      { route },
    );
  }

  it("names the imprint and says the text is still to come", () => {
    renderAt(LEGAL_PATHS.imprint);

    expect(screen.getByRole("heading", { level: 1, name: "Legal notice" })).toBeInTheDocument();
    expect(screen.getByText(/has not been written yet/)).toBeInTheDocument();
  });

  it("does the same for the privacy page", () => {
    renderAt(LEGAL_PATHS.privacy);

    expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByText(/has not been written yet/)).toBeInTheDocument();
  });

  it("invents no legal text in the meantime", () => {
    renderAt(LEGAL_PATHS.privacy);

    // The one thing worse than a missing privacy statement is a made-up one, which a reader would
    // take for a commitment the product has not actually made.
    const body = document.body.textContent ?? "";
    for (const word of ["GDPR", "DSGVO", "Verantwortlicher", "controller", "cookie"]) {
      expect(body.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("offers the way back to the landing page", () => {
    renderAt(LEGAL_PATHS.imprint);

    expect(screen.getByRole("link", { name: "Back to the start page" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
