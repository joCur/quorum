import * as React from "react";
import { ChevronRight, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  MAX_VOCABULARY_TERMS as MAX_TERMS,
  TRANSCRIPTION_LANGUAGES,
  type TranscriptionLanguage,
} from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useAuth } from "@/features/auth/auth-provider";
import { useUserSettings } from "@/features/settings/use-user-settings";
import { THEME_PREFERENCES, useTheme, type ThemePreference } from "@/features/theme/theme-provider";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";
import { APP_VERSION } from "@/env";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";

const THEME_LABEL_KEYS = {
  system: "settings.appearance.system",
  light: "settings.appearance.light",
  dark: "settings.appearance.dark",
} as const satisfies Record<ThemePreference, string>;

const LANGUAGE_LABELS = {
  en: "English",
  de: "Deutsch",
} as const satisfies Record<SupportedLanguage, string>;

/**
 * Settings screen: appearance, language, transcription, the vocabulary, the account, and what
 * this build is.
 *
 * One panel of rows rather than a card each. These are short settings, not separate subjects — a
 * card apiece gave each the weight of a section and made the screen a stack of near-empty boxes.
 * The uppercase row label names its group, so nothing is lost by dropping the headings.
 */
export function SettingsRoute() {
  const { t, i18n } = useTranslation();
  const { preference, setPreference } = useTheme();
  const { user, signOut } = useAuth();
  const settings = useUserSettings();
  const [signingOut, setSigningOut] = React.useState(false);
  const activeLanguage = i18n.resolvedLanguage ?? "en";

  // Whatever the token actually carries, most recognizable first. A session with no readable name
  // is still a session that can be signed out of, so the row never depends on finding one.
  const profile = user?.profile;
  const identity = profile?.name ?? profile?.preferred_username ?? profile?.email ?? null;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-display-lg">{t("settings.title")}</h1>

      <Card className="divide-y divide-border overflow-hidden">
        <Row label={t("settings.appearance.title")}>
          <Pills
            groupLabel={t("settings.appearance.theme")}
            options={THEME_PREFERENCES}
            active={preference}
            render={(option) => t(THEME_LABEL_KEYS[option])}
            onChoose={setPreference}
          />
        </Row>

        <Row label={t("settings.language.title")}>
          <Pills
            groupLabel={t("settings.language.label")}
            options={SUPPORTED_LANGUAGES}
            active={activeLanguage}
            render={(language) => LANGUAGE_LABELS[language]}
            onChoose={(language) => void i18n.changeLanguage(language)}
          />
        </Row>

        {/* The language meetings are recorded in — a different thing from the language of this
            screen, which is why it is its own row rather than a second control under the one
            above. It is only a default: every recording can still say otherwise before it
            starts. */}
        <Row label={t("settings.transcription.title")}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="transcription-language">{t("settings.transcription.label")}</Label>
            <Select
              id="transcription-language"
              className="max-w-xs"
              disabled={settings.status === "loading" || settings.saving}
              value={settings.settings.transcriptionLanguage ?? ""}
              onChange={(event) => {
                const chosen =
                  event.target.value === "" ? null : (event.target.value as TranscriptionLanguage);
                // The select keeps showing what is stored, so a failed save leaves it on the old
                // value rather than on a choice that was never written. Saying so is what keeps
                // that from reading as the setting quietly refusing to move.
                void settings
                  .chooseTranscriptionLanguage(chosen)
                  .catch(() => notify.failure(t("settings.transcription.saveFailed")));
              }}
            >
              {/* "Not chosen" is a state of its own, not a synonym for detection: it leaves the
                  choice to however this installation is configured. */}
              <option value="">{t("settings.transcription.unset")}</option>
              {TRANSCRIPTION_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {t(`transcriptionLanguages.${language}`)}
                </option>
              ))}
            </Select>
            <p className="text-sm text-muted-foreground">{t("settings.transcription.help")}</p>
          </div>
        </Row>

        {/* A reference, not the list: inline, forty entries pushed the account row and its
            sign-out button off the screen. */}
        <Row label={t("settings.vocabulary.title")}>
          <Link
            to="/settings/vocabulary"
            className="-mx-2 flex min-h-[44px] items-center justify-between gap-3 rounded-sm px-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="text-sm">{t("settings.vocabulary.manage")}</span>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <span className="tabular-figures">
                {t("settings.vocabulary.count", {
                  count: settings.settings.vocabulary.length,
                  max: MAX_TERMS,
                })}
              </span>
              <ChevronRight aria-hidden="true" className="size-4" />
            </span>
          </Link>
        </Row>

        <Row label={t("settings.about.title")}>
          <span className="text-sm text-muted-foreground">
            {t("settings.about.version")}{" "}
            <span className="font-mono tabular-figures">{APP_VERSION}</span>
          </span>
          <span className="text-sm text-muted-foreground">{t("settings.about.privacy")}</span>
        </Row>

        {/* The account, last. Nothing here is what a user came to this screen to change: who is
            signed in is a fact to check, and signing out ends the session — neither belongs above
            the preferences it would interrupt. */}
        <Row label={t("settings.account.title")}>
          {identity ? (
            <span className="text-sm text-muted-foreground">
              {t("settings.account.signedInAs")} <span className="font-medium">{identity}</span>
            </span>
          ) : null}
          <Button
            variant="outline"
            className="self-start rounded-full"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOut().finally(() => setSigningOut(false));
            }}
          >
            <LogOut aria-hidden="true" />
            {signingOut ? t("settings.account.signingOut") : t("settings.account.signOut")}
          </Button>
        </Row>
      </Card>
    </div>
  );
}

/** One row of the panel, under the uppercase label that names it. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 p-4 md:px-5">
      <h2 className="text-section-label uppercase text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

/**
 * A choice between a handful of named options, as pills.
 *
 * A radiogroup rather than a set of toggles: exactly one of these is in effect at any moment, and
 * that is what tells a screen reader user how many choices there are and which one they are on.
 * The group keeps its own label — the row heading says what the setting is about, the group label
 * says what is being chosen.
 */
function Pills<T extends string>({
  groupLabel,
  options,
  active,
  render,
  onChoose,
}: {
  groupLabel: string;
  options: readonly T[];
  active: string;
  render: (option: T) => string;
  onChoose: (option: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={groupLabel} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={active === option}
          onClick={() => onChoose(option)}
          className={cn(
            "min-h-[44px] flex-1 rounded-full border px-4 text-sm font-medium transition-colors duration-micro ease-enter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            active === option
              ? "border-honey-strong bg-honey-subtle text-honey-strong"
              : "border-input hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}
