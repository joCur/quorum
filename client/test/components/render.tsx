import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";

/**
 * Renders a component inside the providers the app always gives it.
 *
 * The real i18n instance is used rather than a stub, on purpose: a component referencing a key
 * that does not exist renders the key itself, and assertions on the actual English strings turn
 * that into a failing test. A stub that echoed keys back would hide exactly that bug.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions & { route?: string } = {},
): RenderResult {
  const { route = "/", ...rest } = options;

  function Providers({ children }: { children: ReactNode }) {
    return (
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </I18nextProvider>
    );
  }

  return render(ui, { wrapper: Providers, ...rest });
}

/** Forces a known language, so assertions can name the strings they expect. */
export async function useLanguage(language: "en" | "de"): Promise<void> {
  await i18n.changeLanguage(language);
}
