import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/** How long the gesture has to be held. Mirrors `--duration-hold-to-stop`. */
export const HOLD_DURATION_MS = 1200;

/** Ring refresh while holding — smooth enough to read as a fill, cheap enough to be free. */
const HOLD_TICK_MS = 40;

/**
 * With reduced motion the ring advances in four visible steps instead of gliding. The interaction
 * still has to be legible — a hold with no feedback at all is a button that appears broken — so
 * the ring renders, it just stops animating; the hint text carries the rest.
 */
const REDUCED_MOTION_TICK_MS = HOLD_DURATION_MS / 4;

/**
 * A click arriving this soon after a press we handled ourselves is that press's own click, not a
 * separate activation.
 */
const GESTURE_CLICK_WINDOW_MS = 1000;

/** How long a synthesized activation stays armed before it forgets it was pressed. */
const ARMED_WINDOW_MS = 5000;

type Mode = "idle" | "holding" | "armed";

/**
 * Stopping is a press-and-hold, which is why there is no confirmation dialog any more.
 *
 * The dialog existed to prevent pocket-stops on mobile. Holding solves the same problem inside the
 * gesture rather than after it: press and hold for 1.2s and a conic-gradient ring fills around the
 * button; release early and the ring empties and nothing happened.
 *
 * Three input paths reach the same state machine:
 *
 * - **Pointer** (touch, mouse, pen) — one `pointerdown`/`pointerup` pair covers all of them, with
 *   `pointercancel` and leaving the button treated as a release.
 * - **Keyboard** — holding Space or Enter is the same gesture with the same timing, so keyboard
 *   users learn one interaction rather than a parallel one. The default activation is suppressed
 *   (`preventDefault` on keydown) so the browser's synthetic click cannot short-circuit the hold.
 * - **Synthesized activation** — assistive technology (screen reader passthrough, switch access,
 *   voice control) activates a button by dispatching a click with no pointer or key sequence
 *   behind it. A gesture is not available to those users at all, so for them the hold degrades to
 *   a delayed confirm: the first activation arms the button and says so, a second within five
 *   seconds stops. That keeps the accidental-stop protection the hold exists for, in the only
 *   shape a synthesized activation can carry it, rather than stopping on a single stray click.
 *
 * The button is red while audio is being captured and neutral while it is not. Red is reserved
 * for live capture and is never on screen without it (STATES.md §2) — a red control on a paused
 * screen is exactly the "am I still being recorded?" ambiguity that rule exists to prevent. The
 * shape, the position and the gesture are unchanged, so the control stays the same control.
 */
export function HoldToStopButton({ active, onStop }: { active: boolean; onStop: () => void }) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();

  const [progress, setProgress] = React.useState(0);
  const [mode, setMode] = React.useState<Mode>("idle");
  const timer = React.useRef<number | null>(null);
  // When the pointer or keyboard path last did something. A browser fires a click after a real
  // press, and that click must not be mistaken for the separate, gesture-less activation that
  // assistive technology produces.
  const gesturedAt = React.useRef(0);

  const clearTimer = React.useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  }, []);

  React.useEffect(() => clearTimer, [clearTimer]);

  const begin = React.useCallback(() => {
    if (timer.current !== null) return;
    gesturedAt.current = Date.now();
    const startedAt = gesturedAt.current;
    setMode("holding");
    setProgress(0);
    timer.current = window.setInterval(
      () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= HOLD_DURATION_MS) {
          clearTimer();
          setMode("idle");
          setProgress(0);
          onStop();
          return;
        }
        setProgress(elapsed / HOLD_DURATION_MS);
      },
      reducedMotion ? REDUCED_MOTION_TICK_MS : HOLD_TICK_MS,
    );
  }, [clearTimer, onStop, reducedMotion]);

  const release = React.useCallback(() => {
    if (timer.current === null) return;
    gesturedAt.current = Date.now();
    clearTimer();
    setMode("idle");
    setProgress(0);
  }, [clearTimer]);

  // Only a deliberate second activation stops; an arming that is left alone expires on its own.
  React.useEffect(() => {
    if (mode !== "armed") return;
    const handle = window.setTimeout(() => setMode("idle"), ARMED_WINDOW_MS);
    return () => window.clearTimeout(handle);
  }, [mode]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    // Auto-repeat while the key is down would restart the hold on every repeat.
    if (event.repeat) return;
    event.preventDefault();
    begin();
  }

  function handleKeyUp(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    release();
  }

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    // `detail` counts the clicks behind the event: a real press has at least one, and an
    // activation synthesized by assistive technology has none. The elapsed-time guard covers the
    // browsers that report 0 for a touch-generated click as well — a click that closely follows a
    // press we already handled is that press, not a separate request.
    if (event.detail !== 0 || Date.now() - gesturedAt.current < GESTURE_CLICK_WINDOW_MS) return;
    if (mode === "armed") {
      setMode("idle");
      onStop();
      return;
    }
    setMode("armed");
  }

  // Whole quarters with reduced motion, so the ring reads as steps rather than as a sweep.
  const shown = reducedMotion ? Math.floor(progress * 4) / 4 : progress;
  const degrees = Math.round(shown * 360);
  const hintKey =
    mode === "armed"
      ? "recording.holdToStop.armed"
      : mode === "holding"
        ? "recording.holdToStop.holding"
        : "recording.holdToStop.hint";

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        data-testid="hold-to-stop"
        aria-label={t("recording.holdToStop.label")}
        aria-describedby="hold-to-stop-hint"
        onPointerDown={begin}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={handleClick}
        // The ring is the button's own background, so nothing overlaps the hit target and the
        // 92px circle stays one control for touch and for pointer capture alike.
        style={{
          background: `conic-gradient(hsl(var(--foreground)) ${degrees}deg, ${
            active ? "hsl(var(--recording) / 0.3)" : "hsl(var(--border))"
          } ${degrees}deg)`,
        }}
        className="flex size-[92px] touch-none select-none items-center justify-center rounded-full p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span
          className={cn(
            "flex size-[78px] items-center justify-center rounded-full",
            active ? "bg-recording" : "bg-card ring-1 ring-inset ring-border",
          )}
        >
          <span
            className={cn(
              "size-[26px] rounded-[7px]",
              active ? "bg-recording-foreground" : "bg-foreground",
            )}
          />
        </span>
      </button>
      {/* Live, because the hint is the only thing that reports how the hold is going to a user who
          cannot see the ring — and it is what tells an armed button that it is armed. */}
      <span
        id="hold-to-stop-hint"
        role="status"
        data-testid="hold-to-stop-hint"
        className="text-xs text-muted-foreground"
      >
        {t(hintKey as "recording.holdToStop.hint")}
      </span>
    </div>
  );
}
