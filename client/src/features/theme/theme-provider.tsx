import * as React from "react";

/**
 * Color scheme handling. The default follows the operating system; an explicit
 * choice is remembered locally and wins over it (design system §2).
 */
export const THEME_STORAGE_KEY = "quorum.theme";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The scheme actually on screen, once "system" has been resolved against the OS setting. */
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /**
   * The scheme currently in effect. Components styled with the design tokens never need this —
   * the `dark` class on the document element switches the tokens underneath them. It exists for
   * third-party components that ship their own light and dark styling and have to be told which
   * one applies.
   */
  resolved: ResolvedTheme;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && (THEME_PREFERENCES as readonly string[]).includes(stored)) {
      return stored as ThemePreference;
    }
  } catch {
    // Private browsing modes can throw on access; the system default is fine.
  }
  return "system";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(readStoredPreference);
  const [resolved, setResolved] = React.useState<ResolvedTheme>("light");

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = preference === "dark" || (preference === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      setResolved(dark ? "dark" : "light");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  const setPreference = React.useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not being able to remember the choice is not worth an error to the user.
    }
  }, []);

  const value = React.useMemo(
    () => ({ preference, setPreference, resolved }),
    [preference, setPreference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside a ThemeProvider");
  }
  return context;
}
