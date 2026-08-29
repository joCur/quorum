import "i18next";
import type en from "./locales/en.json";

/**
 * Makes translation keys type-checked against the en-US catalog: a missing or
 * misspelled key fails the build instead of rendering the raw key at runtime.
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
