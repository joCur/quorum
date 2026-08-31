import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

/**
 * The two legal pages the landing's footer links to: the imprint and the privacy statement.
 *
 * Their actual content is a ticket of its own, and it is not a page anyone should improvise — an
 * imprint and a privacy statement are legal texts with real requirements behind them. Until that
 * text exists, these say so plainly rather than either leaving the footer pointing at nothing or
 * putting invented legal wording in front of a visitor.
 *
 * They are public: a visitor has to be able to read them without an account, which is half the
 * point of an imprint.
 */
export const LEGAL_PATHS = {
  imprint: "/legal/imprint",
  privacy: "/legal/privacy",
} as const;

export function LegalPlaceholderRoute({ page }: { page: keyof typeof LEGAL_PATHS }) {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1120px] flex-col px-5 py-10 sm:px-7 sm:py-16">
      <main className="flex flex-1 flex-col items-start gap-6">
        <h1 className="max-w-[20ch] font-display text-[clamp(2rem,5vw,3rem)] font-black leading-[1.06] tracking-[-0.03em]">
          {t(`legal.${page}.title`)}
        </h1>
        <p className="max-w-[60ch] text-[17px] leading-[1.7] text-muted-foreground [text-wrap:pretty]">
          {t("legal.pending")}
        </p>
        <Link
          to="/"
          className="rounded-pill bg-primary px-[22px] py-3 text-sm font-bold text-primary-foreground transition-opacity duration-micro ease-enter hover:opacity-90"
        >
          {t("legal.back")}
        </Link>
      </main>
    </div>
  );
}
