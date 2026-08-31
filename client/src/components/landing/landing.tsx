import * as React from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LEGAL_PATHS } from "@/routes/legal";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * The signed-out landing page.
 *
 * One promise in the headline, three steps that say what using Quorum actually looks like, and a
 * plain statement about who the recordings belong to. There is exactly one action on the page —
 * sign in — offered in the header and again under the headline, so a visitor who has scrolled past
 * the fold does not have to scroll back.
 *
 * The page has a hand-made streak: the highlighter behind the marked word sits at a slight angle,
 * the step cards are pinned down slightly crooked and straighten when pointed at, and the lead
 * sentence types itself out. None of it carries meaning — under `prefers-reduced-motion` the
 * sentence is simply there and the bars stand at their heights.
 */

/** The Q tile with its honey dot — the app icon's letterform, as decoration. */
function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="relative grid size-[34px] place-items-center rounded-[10px] bg-primary font-display text-[19px] font-extrabold leading-none text-primary-foreground"
    >
      Q
      <span className="absolute bottom-[5px] right-[5px] size-1.5 rounded-full bg-brand-dot" />
    </span>
  );
}

/** The one action on the page. Pill-shaped, in the action color, in two sizes. */
function SignInButton({
  onSignIn,
  disabled,
  size,
}: {
  onSignIn: () => void;
  disabled?: boolean;
  size: "sm" | "lg";
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSignIn}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center rounded-pill bg-primary font-bold text-primary-foreground",
        "transition-opacity duration-micro ease-enter hover:opacity-90 disabled:pointer-events-none disabled:opacity-50",
        size === "sm"
          ? "min-h-[44px] px-[22px] text-sm"
          : "min-h-[56px] px-[34px] text-[16.5px] shadow-md",
      )}
    >
      {t("auth.signIn")}
    </button>
  );
}

/**
 * The lead sentence, typing itself out.
 *
 * The whole sentence is the paragraph's accessible name from the first frame, so a screen reader
 * reads it once and completely instead of following the animation character by character. The
 * visible half is decoration, and the reserved height keeps the page from jumping as it fills.
 */
function TypedLead({ text }: { text: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const [typed, setTyped] = React.useState(0);

  React.useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => {
      setTyped((count) => {
        if (count >= text.length) {
          window.clearInterval(timer);
          return count;
        }
        return Math.min(text.length, count + 3);
      });
    }, 30);
    return () => window.clearInterval(timer);
  }, [text.length, reducedMotion]);

  // With reduced motion the sentence is simply there; nothing waits on the timer that never ran.
  const shown = reducedMotion ? text : text.slice(0, typed);

  return (
    <p
      aria-label={text}
      className="min-h-[4.6em] max-w-[50ch] text-[19px] text-muted-foreground [text-wrap:pretty]"
    >
      <span aria-hidden="true">{shown}</span>
      <span
        aria-hidden="true"
        className={cn(
          "ml-px inline-block h-[1em] w-0.5 bg-honey-strong align-[-0.12em]",
          shown.length >= text.length && "opacity-0",
        )}
      />
    </p>
  );
}

/**
 * The bars beside the headline: a recording, drawn as a level meter rather than photographed.
 *
 * Purely decorative, so it is hidden from assistive technology. The heights are fixed rather than
 * random — this is a picture, not a live signal, and a picture should look the same every time.
 */
const WAVE_BARS = [
  { height: 36, tone: "line" },
  { height: 88, tone: "honey" },
  { height: 150, tone: "ink" },
  { height: 64, tone: "line" },
  { height: 196, tone: "honey" },
  { height: 120, tone: "ink" },
  { height: 220, tone: "ink" },
  { height: 76, tone: "honey" },
  { height: 160, tone: "line" },
  { height: 104, tone: "ink" },
  { height: 48, tone: "honey" },
  { height: 132, tone: "line" },
  { height: 30, tone: "ink" },
] as const;

const WAVE_TONE = {
  line: "bg-border",
  honey: "bg-honey",
  ink: "bg-primary",
} as const;

function Wave() {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="flex min-h-[230px] flex-1 basis-[320px] items-end justify-center gap-1.5"
    >
      {WAVE_BARS.map((bar, index) => (
        <span
          key={`${bar.tone}-${bar.height}-${index}`}
          className={cn(
            "w-3.5 origin-bottom rounded-pill",
            WAVE_TONE[bar.tone],
            !reducedMotion && "animate-bar-grow",
          )}
          style={{
            height: `${bar.height}px`,
            animationDelay: reducedMotion ? undefined : `${0.15 + index * 0.05}s`,
          }}
        />
      ))}
    </div>
  );
}

const STEP_NUMBERS = { record: "1", read: "2", share: "3" } as const;

/**
 * One of the three steps.
 *
 * The cards are pinned down at slightly different angles and straighten when pointed at. The tilt
 * is a resting state rather than movement, so it survives reduced motion; what reduced motion
 * drops is the transition between the two.
 */
function StepCard({
  step,
  tilt,
  numberTilt,
}: {
  step: keyof typeof STEP_NUMBERS;
  tilt: string;
  numberTilt: string;
}) {
  const { t } = useTranslation();

  return (
    <li
      className={cn(
        "flex flex-1 basis-[280px] flex-col gap-3.5 rounded-card-lg border border-border bg-card px-7 py-[30px] shadow-sm",
        "transition-[transform,box-shadow] duration-large ease-spring motion-reduce:transition-none",
        "hover:rotate-0 hover:shadow-md sm:hover:-translate-y-1.5",
        tilt,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-[52px] place-items-center rounded-full bg-honey font-display text-[26px] font-black text-honey-foreground",
          numberTilt,
        )}
      >
        {STEP_NUMBERS[step]}
      </span>
      <h2 className="font-display text-xl font-bold">{t(`landing.steps.${step}.title`)}</h2>
      <p className="text-[15px] leading-[1.65] text-muted-foreground [text-wrap:pretty]">
        {t(`landing.steps.${step}.body`)}
      </p>
    </li>
  );
}

/**
 * The privacy block.
 *
 * One honey panel with a headline and two paragraphs — deliberately not a row of feature cards
 * with icons. These are commitments about someone's recordings, and dressing them up as features
 * would make them read as marketing (STATES.md — serious moments rendered straight).
 */
function PrivacySection() {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col items-start gap-6 rounded-[28px] bg-honey-subtle p-8 sm:p-11 lg:px-11 lg:py-14">
      <span className="text-xs font-extrabold uppercase tracking-[0.1em] text-honey-strong">
        {t("landing.privacy.eyebrow")}
      </span>
      <h2 className="max-w-[22ch] font-display text-[clamp(1.875rem,4.5vw,3rem)] font-black leading-[1.06] tracking-[-0.03em] [text-wrap:balance]">
        {t("landing.privacy.title")}
      </h2>
      <div className="flex flex-wrap gap-8 text-[15.5px] leading-[1.7] text-muted-foreground">
        <p className="flex-1 basis-[300px] [text-wrap:pretty]">{t("landing.privacy.ownership")}</p>
        <p className="flex-1 basis-[300px] [text-wrap:pretty]">{t("landing.privacy.deletion")}</p>
      </div>
    </section>
  );
}

export function Landing({
  onSignIn,
  signInDisabled = false,
  notice,
}: {
  onSignIn: () => void;
  signInDisabled?: boolean;
  /** Anything the sign-in flow needs to say first — an expired session, a failed callback. */
  notice?: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-5 py-5 sm:px-7">
        <span className="flex items-center gap-2.5">
          <BrandMark />
          <span className="font-display text-xl font-extrabold tracking-[-0.02em]">
            {t("app.name")}
          </span>
        </span>
        <SignInButton onSignIn={onSignIn} disabled={signInDisabled} size="sm" />
      </header>

      <main className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col gap-16 px-5 pb-16 pt-10 sm:gap-24 sm:px-7 sm:pb-[72px] sm:pt-16">
        <section className="flex flex-wrap items-center gap-12">
          <div className="flex flex-1 basis-[420px] flex-col gap-7">
            <h1 className="font-display text-[clamp(2.75rem,7vw,5.25rem)] font-black leading-none tracking-[-0.035em] [text-wrap:balance]">
              {t("landing.hero.before")}{" "}
              {/* The highlighter: a honey field behind the word, set down slightly askew, the way
                  someone marking up a printout would. */}
              <span className="inline-block -rotate-2 rounded-[0.22em] bg-honey px-[0.18em] pb-[0.04em] text-honey-foreground">
                {t("landing.hero.highlighted")}
              </span>{" "}
              {t("landing.hero.after")}
            </h1>
            {/* Keyed on the sentence: switching language starts the typing over rather than
                continuing a count into a different string. */}
            <TypedLead key={t("landing.hero.lead")} text={t("landing.hero.lead")} />
            {notice}
            <div className="flex flex-wrap items-center gap-4 sm:gap-[18px]">
              <SignInButton onSignIn={onSignIn} disabled={signInDisabled} size="lg" />
              <span className="text-sm text-muted-foreground">{t("landing.hero.reach")}</span>
            </div>
          </div>
          <Wave />
        </section>

        <ul className="flex list-none flex-wrap items-stretch gap-[22px]">
          <StepCard step="record" tilt="-rotate-[1.2deg]" numberTilt="rotate-6" />
          <StepCard step="read" tilt="rotate-1" numberTilt="-rotate-6" />
          <StepCard step="share" tilt="-rotate-[0.8deg]" numberTilt="rotate-6" />
        </ul>

        <PrivacySection />
      </main>

      {/* A working footer rather than a slogan: the mark, the copyright line, and the two legal
          pages a visitor is entitled to reach without an account. */}
      <footer className="border-t border-border px-5 py-5 text-[13px] text-muted-foreground sm:px-7">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="relative grid size-5 place-items-center rounded-[6px] bg-primary font-display text-[11px] font-extrabold leading-none text-primary-foreground"
            >
              Q
            </span>
            <span>{t("landing.footer.copyright", { year: new Date().getFullYear() })}</span>
          </span>
          <Link to={LEGAL_PATHS.imprint} className="underline-offset-4 hover:underline">
            {t("landing.footer.imprint")}
          </Link>
          <Link to={LEGAL_PATHS.privacy} className="underline-offset-4 hover:underline">
            {t("landing.footer.privacy")}
          </Link>
        </div>
      </footer>
    </div>
  );
}
