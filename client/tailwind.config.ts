import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Tailwind theme mapping for the Quorum design tokens.
 *
 * Every value here resolves to a CSS custom property defined in
 * `src/styles/tokens.css`; the design system is the source of truth and this
 * file only exposes it as utility classes. Components use semantic classes
 * exclusively — no raw palette classes, no hex values.
 */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      screens: {
        // The app shell's own breakpoint. Below it the top bar sheds its words
        // — the wordmark and the record label — and keeps every control.
        shell: "760px",
      },
      maxWidth: {
        // The shell's content column, shared by the top bar and the main
        // column so the two stay aligned at every width.
        shell: "var(--shell-width)",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Honey — the single expressive accent. It carries personality and
        // selection, never status.
        honey: {
          DEFAULT: "hsl(var(--honey))",
          strong: "hsl(var(--honey-strong))",
          subtle: "hsl(var(--honey-subtle))",
        },
        // The v2 palette has no second expressive accent. `plum` stays as a
        // name only so the screens that still reference it keep rendering; it
        // now resolves to honey. The summary and template area tickets replace
        // these usages with honey (underline instead of bar) and drop the name.
        plum: {
          DEFAULT: "hsl(var(--honey-strong))",
          subtle: "hsl(var(--honey-subtle))",
        },
        // Brand mark dot — honey on the espresso mark, inverted in dark mode.
        "brand-dot": "hsl(var(--brand-dot))",
        // The recording screen is a fixed dark room in both themes.
        "on-air": {
          DEFAULT: "hsl(var(--on-air))",
          foreground: "hsl(var(--on-air-foreground))",
        },
        // Status colors — state, and only state.
        recording: {
          DEFAULT: "hsl(var(--recording))",
          foreground: "hsl(var(--recording-foreground))",
          subtle: "hsl(var(--recording-subtle))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
          subtle: "hsl(var(--success-subtle))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          subtle: "hsl(var(--warning-subtle))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
          subtle: "hsl(var(--info-subtle))",
        },
      },
      borderRadius: {
        // shadcn scale, now anchored on the card radius rather than a
        // computed offset, so the three steps land on real token values.
        lg: "var(--radius-card-lg)",
        md: "var(--radius)",
        sm: "var(--radius-field-sm)",
        // Named steps for the v2 shapes: pills for controls, 16-22px cards.
        pill: "var(--radius-pill)",
        card: "var(--radius-card)",
        "card-sm": "var(--radius-card-sm)",
        "card-lg": "var(--radius-card-lg)",
        field: "var(--radius-field)",
        "field-sm": "var(--radius-field-sm)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      fontFamily: {
        // Display face for headings and the brand mark (weights 500-900).
        display: [
          "Schibsted Grotesk",
          "Figtree",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        sans: ["Figtree", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        timer: ["2.25rem", { lineHeight: "1", fontWeight: "500" }],
      },
      transitionDuration: {
        micro: "140ms",
        DEFAULT: "220ms",
        large: "320ms",
        celebrate: "600ms",
        // Hold-to-stop is interaction motion: the ring tracks the finger.
        "hold-to-stop": "1200ms",
      },
      transitionTimingFunction: {
        enter: "cubic-bezier(0.2, 0, 0, 1)",
        exit: "cubic-bezier(0.4, 0, 1, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      keyframes: {
        "recording-pulse": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.5", transform: "scale(0.85)" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.6)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "recording-pulse": "recording-pulse 1.6s cubic-bezier(0.2, 0, 0, 1) infinite",
        "rise-in": "rise-in 220ms cubic-bezier(0.2, 0, 0, 1) both",
        "pop-in": "pop-in 220ms cubic-bezier(0.34, 1.56, 0.64, 1) both",
        shimmer: "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
