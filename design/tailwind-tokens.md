# Token mapping: Tailwind CSS + shadcn/ui

How `tokens.css` maps into the frontend stack (React + Vite PWA, Tailwind CSS, shadcn/ui).
`tokens.css` here is a verbatim copy of the app's `client/src/styles/tokens.css`; the two must stay
byte-identical.

## 1. shadcn/ui setup

`tokens.css` follows the shadcn CSS-variable convention exactly (`--background`, `--primary`,
`--radius`, `.dark` overrides), so `components.json` uses:

```json
{
  "style": "default",
  "tailwind": {
    "baseColor": "stone",
    "cssVariables": true
  }
}
```

All shadcn components then pick up Quorum colors with zero per-component changes. Dark mode: class
strategy (`darkMode: ["class"]`), toggled by adding `.dark` to `<html>`; default follows
`prefers-color-scheme` with a manual override stored in settings.

Note that `--primary` is **espresso in light mode and honey in dark mode** — the action color is not
a single hue that lightens. Components must never reach past `bg-primary` to a specific hue.

## 2. tailwind.config.ts

```ts
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
      // The app's two pieces of sticky furniture, as named sizes: the top bar
      // sets its own height from `h-top-bar`, and a screen that sticks something
      // underneath it offsets from the same tokens instead of guessing.
      spacing: {
        "top-bar": "var(--top-bar-height)",
        "player-bar": "var(--player-bar-height)",
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
```

Note: if the app is scaffolded on Tailwind v4, express the same mapping via `@theme inline` in CSS
instead of `tailwind.config.ts`; token names and values are identical (that is the point of keeping
`tokens.css` framework-neutral).

### Radius mapping

v2 introduces explicit radius tokens instead of deriving the scale from a single base with pixel
offsets. `--radius` remains the shadcn base and equals the card radius (18px), and the three shadcn
steps now resolve to real token values:

| Tailwind class | Token | Value |
|---|---|---|
| `rounded-sm` | `--radius-field-sm` | 10px |
| `rounded-md` | `--radius` | 18px |
| `rounded-lg` | `--radius-card-lg` | 22px |
| `rounded-pill` | `--radius-pill` | 999px |
| `rounded-field` | `--radius-field` | 12px |
| `rounded-card-sm` | `--radius-card-sm` | 16px |
| `rounded-card` | `--radius-card` | 18px |
| `rounded-card-lg` | `--radius-card-lg` | 22px |

Controls use `rounded-pill` (or `rounded-full`, which is equivalent) — every button, chip, badge,
nav item and search field. Cards use `rounded-card` unless they are a dialog or sheet
(`rounded-card-lg`) or an inline callout (`rounded-card-sm`).

## 3. Fonts (self-hosted, no CDN)

```bash
pnpm --filter @quorum/client add @fontsource/schibsted-grotesk @fontsource/figtree @fontsource/jetbrains-mono
```

```ts
// src/main.tsx
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/700.css";
import "@fontsource/schibsted-grotesk/800.css";
import "@fontsource/schibsted-grotesk/900.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
```

Static weight files, not the variable builds, so the shipped weights match the design exactly. Vite
bundles the WOFF2 files into the app; no runtime requests to Google Fonts or any CDN.

`font-sans` (Figtree) is the body default, applied on `body`. `font-display` (Schibsted Grotesk) is
applied to `h1`/`h2`/`h3` in the base layer and opted into elsewhere for display text — the brand
mark, dialog titles, summary section titles.

## 4. Usage rules

- Components use semantic Tailwind classes only (`bg-card`, `text-muted-foreground`,
  `border-border`, `bg-recording`, `bg-honey-subtle`). Never raw palette classes (`bg-red-500`) and
  never hex values in components.
- `recording` color exclusively for active-capture UI; errors always use `destructive`.
- `honey` is expressive only — never to signal success/failure/warning. Honey is not `warning`.
- Honey has three steps and they are not interchangeable: `bg-honey` for fills, `text-honey-strong`
  for text and icons (including on `bg-honey-subtle`), `bg-honey-subtle` for tints. `text-honey` on
  a paper background fails contrast.
- `plum` is **deprecated**. It survives as a Tailwind color name that resolves to the honey tokens,
  purely so screens not yet restyled keep rendering. Do not add new `plum` usages; the area tickets
  that restyle those screens remove the name.
- Status badges: `bg-{status}-subtle text-{status}` (e.g. `bg-info-subtle text-info`).
- Timers/timestamps: `font-mono` (or `tabular-nums` when inline in sans text).
- Playful motion via the shared animation utilities (`animate-rise-in`, `animate-pop-in`,
  `animate-recording-pulse`, `animate-active-shimmer`) — no ad-hoc keyframes in components, and
  every animation honors `prefers-reduced-motion` (handled centrally in `tokens.css`).
- Focus: rely on shadcn's `ring` utilities — do not remove focus outlines.
