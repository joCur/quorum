import { Mic, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, useNavigate } from "react-router-dom";
import { useRecordingSession } from "@/features/recording/recording-context";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { formatDuration } from "@/lib/duration";
import { cn } from "@/lib/utils";

/**
 * The brand mark: the Q tile, with the wordmark next to it where there is room.
 *
 * The tile is the app icon's letterform — espresso field, honey dot, inverted in dark mode — and
 * it is decoration. The wordmark beside it carries the name for assistive technology at every
 * width: visible above the shell breakpoint, screen-reader-only below it. The mark is
 * deliberately not a link; the nav pill already owns "take me to my meetings", and a second
 * control leading to the same place would only add a stop on the way to the ones that differ.
 */
function BrandMark() {
  const { t } = useTranslation();
  return (
    <span className="flex shrink-0 items-center gap-[9px] shell:mr-1.5">
      <span
        aria-hidden="true"
        className="relative grid size-[30px] place-items-center rounded-[9px] bg-primary font-display text-[17px] font-extrabold leading-none text-primary-foreground"
      >
        Q
        <span className="absolute bottom-1 right-1 size-[5px] rounded-full bg-brand-dot" />
      </span>
      <span className="sr-only font-display text-lg font-extrabold tracking-[-0.02em] shell:not-sr-only">
        {t("app.name")}
      </span>
    </span>
  );
}

/** One destination in the segmented nav pill. The current one is filled with the action color. */
function NavPill({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "rounded-pill px-3 py-2 text-[13.5px] font-bold shell:px-[18px] transition-colors duration-micro ease-enter",
          isActive
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
        )
      }
    >
      {label}
    </NavLink>
  );
}

/**
 * The live recording, in the record button's place.
 *
 * A running session is red and says REC with a breathing dot; a paused one drops to a bordered
 * neutral chip with a pause glyph, because a held capture is a state and not an alarm. The whole
 * pill is the way back to the recording screen, which the user may always leave — the session
 * belongs to the app, not to that screen.
 *
 * Only the phase is announced. The timer ticks every second and would turn any live region it
 * shared into a metronome, so it sits outside the one that carries the state.
 */
function LivePill({ active, elapsedSeconds }: { active: boolean; elapsedSeconds: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <button
      type="button"
      data-testid="recording-bar"
      aria-label={t("recording.bar.return")}
      onClick={() => void navigate("/record")}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-pill px-3 py-2.5 text-[12.5px] shell:px-[18px] font-extrabold tracking-[0.05em] transition-colors duration-micro ease-enter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active
          ? "bg-recording text-recording-foreground hover:bg-recording/90"
          : "border border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className={cn(
            "block size-2 shrink-0 rounded-full bg-current",
            !reducedMotion && "animate-recording-pulse",
          )}
        />
      ) : (
        <span aria-hidden="true" className="leading-none">
          ❚❚
        </span>
      )}
      {/* The word is what the narrow bar can afford to lose: red and a breathing dot already say
          "live", and the timer says how long. It is only hidden visually — the phase is still
          read out, and still announced when it changes, at every width. */}
      <span role="status" aria-live="polite" className="sr-only shell:not-sr-only">
        {active ? t("recording.indicator.recording") : t("recording.pill.paused")}
      </span>
      <span className="font-mono font-medium tabular-figures">
        {formatDuration(elapsedSeconds)}
      </span>
    </button>
  );
}

/** Start a recording. Below the shell breakpoint the label drops and the microphone stands alone. */
function RecordPill() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = t("nav.record");

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void navigate("/record")}
      className="flex shrink-0 items-center gap-2 rounded-pill bg-primary px-3 py-2.5 shell:px-5 text-[13.5px] font-bold text-primary-foreground transition-transform duration-micro ease-spring active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Mic className="size-[15px]" aria-hidden="true" />
      <span className="hidden shell:inline">{label}</span>
    </button>
  );
}

/**
 * The one bar the app is navigated from, at every width.
 *
 * There is no sidebar and no bottom tab bar any more: the same row of controls sits at the top of
 * every screen the shell renders, so nothing competes for the bottom edge of a small screen and
 * no view needs an exception from the frame. Below the shell breakpoint the row sheds words —
 * the wordmark and the record label — and keeps every destination.
 */
export function TopBar() {
  const { t } = useTranslation();
  const session = useRecordingSession();
  const phase = session?.state.phase;
  const live = phase === "recording" || phase === "paused";

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/[0.92] backdrop-blur-lg">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-5 py-3 shell:gap-[14px]">
        <BrandMark />

        <nav
          aria-label={t("nav.label")}
          className="flex items-center gap-0.5 rounded-pill border border-border bg-card p-[3px]"
        >
          <NavPill to="/meetings" label={t("nav.meetings")} />
          <NavPill to="/templates" label={t("nav.templates")} />
        </nav>

        <span className="flex-1" />

        <NavLink
          to="/settings"
          aria-label={t("nav.settings")}
          className={({ isActive }) =>
            cn(
              "grid size-9 shrink-0 place-items-center shell:size-[38px] rounded-pill transition-colors duration-micro ease-enter",
              isActive
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:text-foreground",
            )
          }
        >
          <Settings className="size-[19px]" aria-hidden="true" />
        </NavLink>

        {live && session ? (
          <LivePill active={phase === "recording"} elapsedSeconds={session.state.elapsedSeconds} />
        ) : (
          <RecordPill />
        )}
      </div>
    </header>
  );
}
