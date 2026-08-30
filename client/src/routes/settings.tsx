import * as React from "react";
import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-provider";
import { THEME_PREFERENCES, useTheme, type ThemePreference } from "@/features/theme/theme-provider";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";
import { APP_VERSION } from "@/env";
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

/** Settings screen: the account, appearance, language, and what this build is. */
export function SettingsRoute() {
  const { t, i18n } = useTranslation();
  const { preference, setPreference } = useTheme();
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = React.useState(false);
  const activeLanguage = i18n.resolvedLanguage ?? "en";

  // Whatever the session actually carries, most recognizable first. A session with no readable
  // name is still a session that can be signed out of, so the card never depends on finding one.
  // SPIKE: the OIDC id-token `profile` claim set is gone; a better-auth user row has a name and
  // an email and nothing else unless we add columns for it.
  const identity = user?.name ?? user?.email ?? null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold md:text-2xl">{t("settings.title")}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.account.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          {identity ? (
            <span className="text-sm text-muted-foreground">
              {t("settings.account.signedInAs")} <span className="font-medium">{identity}</span>
            </span>
          ) : null}
          <Button
            variant="outline"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOut().finally(() => setSigningOut(false));
            }}
          >
            <LogOut aria-hidden="true" />
            {signingOut ? t("settings.account.signingOut") : t("settings.account.signOut")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.appearance.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label id="theme-label">{t("settings.appearance.theme")}</Label>
          <div role="radiogroup" aria-labelledby="theme-label" className="flex gap-2">
            {THEME_PREFERENCES.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={preference === option}
                onClick={() => setPreference(option)}
                className={cn(
                  "min-h-[44px] flex-1 rounded-sm border px-3 text-sm transition-colors duration-micro ease-enter",
                  preference === option
                    ? "border-primary bg-accent text-accent-foreground"
                    : "border-input hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {t(THEME_LABEL_KEYS[option])}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.language.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label id="language-label">{t("settings.language.label")}</Label>
          <div role="radiogroup" aria-labelledby="language-label" className="flex gap-2">
            {SUPPORTED_LANGUAGES.map((language) => (
              <button
                key={language}
                type="button"
                role="radio"
                aria-checked={activeLanguage === language}
                onClick={() => void i18n.changeLanguage(language)}
                className={cn(
                  "min-h-[44px] flex-1 rounded-sm border px-3 text-sm transition-colors duration-micro ease-enter",
                  activeLanguage === language
                    ? "border-primary bg-accent text-accent-foreground"
                    : "border-input hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {LANGUAGE_LABELS[language]}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.about.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
          <span>
            {t("settings.about.version")}{" "}
            <span className="font-mono tabular-figures">{APP_VERSION}</span>
          </span>
          <span>{t("settings.about.privacy")}</span>
        </CardContent>
      </Card>
    </div>
  );
}
