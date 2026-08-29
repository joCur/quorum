import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";

/**
 * Translation setup. en-US is the source locale — every user-facing string in
 * the app comes from these catalogs, never from a literal in a component.
 */
export const SUPPORTED_LANGUAGES = ["en", "de"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_STORAGE_KEY = "quorum.language";

const resources = {
  en: { translation: en },
  de: { translation: de },
} as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // "de-DE" and "de-AT" both resolve to the "de" catalog.
    load: "languageOnly",
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ["localStorage"],
    },
  });

export default i18n;
