import { LayoutList, ListChecks, Mic, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useMatch, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface Destination {
  to: string;
  icon: LucideIcon;
  labelKey: "nav.meetings" | "nav.templates" | "nav.settings";
}

const MEETINGS: Destination = { to: "/meetings", icon: LayoutList, labelKey: "nav.meetings" };
const TEMPLATES: Destination = { to: "/templates", icon: ListChecks, labelKey: "nav.templates" };
const SETTINGS: Destination = { to: "/settings", icon: Settings, labelKey: "nav.settings" };

const DESTINATIONS: readonly Destination[] = [MEETINGS, TEMPLATES, SETTINGS];

/** Height of the mobile tab bar; the record button overlaps its top edge. */
const TAB_BAR_HEIGHT = "h-16";

function NavItem({ destination, variant }: { destination: Destination; variant: "bar" | "rail" }) {
  const { t } = useTranslation();
  const Icon = destination.icon;
  return (
    <NavLink
      to={destination.to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md transition-colors duration-micro ease-enter",
          variant === "bar"
            ? "min-h-[44px] flex-col justify-center gap-1 text-xs"
            : "px-3 py-2 text-sm font-medium",
          isActive
            ? variant === "bar"
              ? "text-primary"
              : "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:text-foreground",
        )
      }
    >
      <Icon className="size-6" aria-hidden="true" />
      <span>{t(destination.labelKey)}</span>
    </NavLink>
  );
}

/**
 * Record action. On mobile it is the raised circular button that half-overlaps
 * the tab bar; on desktop it is the primary button at the top of the sidebar.
 */
function RecordAction({ variant }: { variant: "fab" | "sidebar" }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = t("nav.record");

  if (variant === "sidebar") {
    return (
      <Button className="w-full justify-start" onClick={() => void navigate("/record")}>
        <Mic aria-hidden="true" />
        {label}
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void navigate("/record")}
      aria-label={label}
      // Half of the button's height sits above the tab bar's top edge.
      className="absolute left-1/2 top-0 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-recording text-recording-foreground shadow-md transition-transform duration-micro ease-spring active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Mic className="size-7" aria-hidden="true" />
    </button>
  );
}

/**
 * Application frame: bottom tab bar below `md`, slim sidebar above it. The
 * recording screen renders outside this shell — it is always full-screen.
 */
export function AppShell() {
  const { t } = useTranslation();
  // The meeting detail is a leaf view: it owns the bottom of the small screen with its playback
  // bar, and its own back link is the way out. Below `md` it is shown without the tab bar.
  const onMeetingDetail = useMatch("/meetings/:meetingId") !== null;

  return (
    // Always a flex container, a column below `md` and a row above it, so `main` is a flex item
    // in both directions and can be told to fill the remaining height. A page that wants to put
    // something at the bottom of the viewport needs a column with a definite height to do it in.
    <div className="flex min-h-dvh flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-card focus:px-3 focus:py-2"
      >
        {t("app.skipToContent")}
      </a>

      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-border bg-card px-4 py-6 md:flex">
        <span className="px-3 text-xl font-bold tracking-tight">{t("app.name")}</span>
        <RecordAction variant="sidebar" />
        <nav aria-label={t("nav.label")} className="flex flex-col gap-1">
          {DESTINATIONS.map((destination) => (
            <NavItem key={destination.to} destination={destination} variant="rail" />
          ))}
        </nav>
      </aside>

      <main
        id="main"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-28 pt-6 md:px-6 md:pb-10"
      >
        <Outlet />
      </main>

      {/* A leaf view takes the whole small screen: the tab bar and its record button step aside
          on the meeting detail, which carries its own way back and puts its playback bar where
          the tab bar would be. The sidebar above `md` is unaffected — it never competes for the
          bottom edge. */}
      {onMeetingDetail ? null : (
        <nav
          aria-label={t("nav.label")}
          className={cn(
            "fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 items-center border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden",
            TAB_BAR_HEIGHT,
          )}
        >
          <NavItem destination={MEETINGS} variant="bar" />
          <div className="relative flex h-full items-center justify-center">
            <RecordAction variant="fab" />
          </div>
          <NavItem destination={TEMPLATES} variant="bar" />
          <NavItem destination={SETTINGS} variant="bar" />
        </nav>
      )}
    </div>
  );
}
