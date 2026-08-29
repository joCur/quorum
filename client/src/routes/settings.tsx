import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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

/** Settings screen. Account and sign-out arrive with the auth flow. */
export function SettingsRoute() {
  const { t, i18n } = useTranslation();
  const { preference, setPreference } = useTheme();
  const activeLanguage = i18n.resolvedLanguage ?? "en";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold md:text-2xl">{t("settings.title")}</h1>

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
          <span>{t("settings.about.selfHosted")}</span>
        </CardContent>
      </Card>
    </div>
  );
}
