import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * The signed-out landing page.
 *
 * This is the whole public face of the product: an editorial hero, three tiles that show what the
 * app does rather than describe it, and the privacy promises as plain text columns. There is
 * exactly one action on the page — sign in — repeated in the header and under the hero, because a
 * visitor who has scrolled past the fold should not have to scroll back up.
 *
 * The page is not a marketing site: it says what happens to a recording and to the data, and then
 * gets out of the way. Everything else lives behind the sign-in.
 */

/** The Q tile with its honey dot — the app icon's letterform, as decoration. */
function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid size-[34px] place-items-center rounded-[10px] bg-primary font-display text-[19px] font-extrabold leading-none text-primary-foreground",
        className,
      )}
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
  className,
}: {
  onSignIn: () => void;
  disabled?: boolean;
  size: "sm" | "lg";
  className?: string;
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
        className,
      )}
    >
      {t("auth.signIn")}
    </button>
  );
}

/** An uppercase label over a tile — the "what happens here" line. */
function TileLabel({ children }: { children: string }) {
  return (
    <span className="text-xs font-extrabold uppercase tracking-[0.08em] text-honey-strong">
      {children}
    </span>
  );
}

/**
 * The three tiles.
 *
 * They wrap rather than sit in a fixed grid: at a wide viewport they read as a row, and each one
 * keeps a floor of 300px so a tile never collapses into a column of broken lines.
 */
function ProductTiles() {
  const { t } = useTranslation();
  const tileBase =
    "flex flex-1 basis-[300px] flex-col justify-center gap-3 rounded-card-lg border border-border bg-card p-7";

  return (
    <div className="flex flex-wrap items-stretch gap-5">
      {/* The on-air tile keeps its own darkness in both themes: it is a picture of a recording in
          progress, not a surface the user is standing on. */}
      <div className="flex flex-1 basis-[300px] flex-col justify-center gap-4 rounded-card-lg bg-on-air p-7 text-on-air-foreground shadow-lg">
        <span className="inline-flex select-none items-center gap-2 self-start rounded-pill bg-recording px-3.5 py-1.5 text-xs font-extrabold tracking-[0.08em] text-recording-foreground">
          <span
            aria-hidden="true"
            className="size-2 animate-recording-pulse rounded-full bg-current"
          />
          {t("landing.tiles.onAir.badge")}
        </span>
        <span className="tabular-figures font-mono text-[44px] leading-none" aria-hidden="true">
          27:14
        </span>
        <span className="text-sm text-on-air-muted [text-wrap:pretty]">
          {t("landing.tiles.onAir.body")}
        </span>
      </div>

      <div className={tileBase}>
        <TileLabel>{t("landing.tiles.transcript.label")}</TileLabel>
        <span className="font-display text-[19px] font-bold">
          {t("landing.tiles.transcript.title")}
        </span>
        <p className="text-sm leading-[1.7] text-muted-foreground [text-wrap:pretty]">
          {t("landing.tiles.transcript.quoteBefore")}
          <span className="rounded-[4px] bg-honey-subtle px-1 py-px text-foreground">
            {t("landing.tiles.transcript.quoteHighlight")}
          </span>
          {t("landing.tiles.transcript.quoteAfter")}
        </p>
      </div>

      <div className={tileBase}>
        <TileLabel>{t("landing.tiles.template.label")}</TileLabel>
        <span className="font-display text-[19px] font-bold">
          {t("landing.tiles.template.title")}
        </span>
        <ul className="flex flex-col gap-1.5 text-[13.5px] text-muted-foreground">
          {(
            t("landing.tiles.template.sections", { returnObjects: true }) as unknown as string[]
          ).map((section) => (
            <li key={section}>— {section}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The privacy promises, as text columns.
 *
 * Deliberately not icon cards: these are commitments about the user's data, and dressing them up
 * as feature bullets would make them read as marketing rather than as the plain statements they
 * are (STATES.md: serious moments are rendered straight).
 */
function PrivacySection() {
  const { t } = useTranslation();
  const promises = ["nothingLost", "yours", "deletion"] as const;

  return (
    <section className="flex flex-col gap-5 border-t border-border pt-11">
      <h2 className="font-display text-3xl font-extrabold tracking-[-0.02em]">
        {t("landing.privacy.title")}
      </h2>
      <div className="flex flex-wrap gap-10 text-[15px]">
        {promises.map((promise) => (
          <div key={promise} className="flex flex-1 basis-[240px] flex-col gap-1.5">
            <span className="font-bold">{t(`landing.privacy.${promise}.title`)}</span>
            <span className="text-muted-foreground [text-wrap:pretty]">
              {t(`landing.privacy.${promise}.body`)}
            </span>
          </div>
        ))}
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

      <main className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col gap-14 px-5 pb-16 pt-10 sm:gap-20 sm:px-7 sm:pb-[72px] sm:pt-14">
        <section className="flex max-w-[820px] flex-col gap-7">
          <h1 className="font-display text-[clamp(2.5rem,6.5vw,4.5rem)] font-black leading-[1.02] tracking-[-0.03em] [text-wrap:pretty]">
            {t("landing.hero.line1")}
            <br />
            {/* The honey underline is a band behind the words, not a text-decoration: it sits
                under the baseline and the descenders sit on top of it. */}
            <span className="[box-shadow:inset_0_-0.28em_hsl(var(--honey)/0.55)]">
              {t("landing.hero.line2")}
            </span>
          </h1>
          <p className="max-w-[52ch] text-[19px] text-muted-foreground [text-wrap:pretty]">
            {t("landing.hero.body")}
          </p>
          {notice}
          <div className="flex flex-wrap items-center gap-4 sm:gap-[18px]">
            <SignInButton onSignIn={onSignIn} disabled={signInDisabled} size="lg" />
            <span className="text-sm text-muted-foreground">{t("landing.hero.reach")}</span>
          </div>
        </section>

        <ProductTiles />
        <PrivacySection />
      </main>

      <footer className="flex justify-center border-t border-border px-7 py-5 text-[13px] text-muted-foreground">
        <span>
          {t("app.name")} — {t("app.tagline")}
        </span>
      </footer>
    </div>
  );
}
