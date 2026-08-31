import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * The consent notice, on the start stage rather than in front of it.
 *
 * The interruption was removed; the obligation was not. The card sits directly above the start
 * button, and the button itself carries the affirmation — the recording cannot begin without the
 * user reading past this and pressing a control that states what they are confirming. There is no
 * dismiss, no collapse and no "don't show again": the notice is part of the stage and is present
 * on every recording start.
 *
 * It is a labelled region rather than a plain box, so screen readers reach the obligation before
 * the control that acts on it, and so the whole notice can be navigated to as one thing.
 *
 * The heading is espresso ink, not honey, even though honey is what makes this card look the way
 * it does. `honey-strong` on a honey tint measures 3.9:1 — fine for large text and glyphs, short
 * of AA at heading size — and a legal notice is the last place to spend a known contrast
 * shortfall. Honey carries the card through its border and its ground; the words stay readable.
 */
export function ConsentCard({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <section
      aria-labelledby="consent-card-title"
      data-testid="consent-card"
      className={cn(
        "flex flex-col gap-1.5 rounded-card-sm border border-honey-strong/45 bg-honey/10 px-4 py-3.5",
        className,
      )}
    >
      <h2 id="consent-card-title" className="text-sm font-bold text-foreground">
        {t("consent.title")}
      </h2>
      <p className="text-pretty text-[13px] leading-relaxed text-muted-foreground">
        {t("consent.body")}
      </p>
    </section>
  );
}
