import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
import { TopBar } from "@/components/layout/top-bar";

/**
 * Application frame: one sticky top bar above the content, at every width.
 *
 * The frame is the same on every screen it renders. Nothing is anchored to the bottom of the
 * viewport any more, so no view has to be excused from the shell to keep its own bottom-edge
 * furniture, and the running recording is visible from all of them — it lives in the bar.
 *
 * The recording screen renders outside this shell: it is always full-screen, and the way out of
 * it is its own close control rather than a navigation choice.
 */
export function AppShell() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-card focus:px-3 focus:py-2"
      >
        {t("app.skipToContent")}
      </a>

      <TopBar />

      <main
        id="main"
        // Same column width and gutter as the bar above it, so the two line up at every width.
        className="mx-auto flex w-full max-w-shell flex-1 flex-col px-5 pb-20 pt-7"
      >
        <Outlet />
      </main>
    </div>
  );
}
