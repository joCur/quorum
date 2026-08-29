# Token mapping: Tailwind CSS + shadcn/ui

How `tokens.css` maps into the frontend stack (React + Vite PWA, Tailwind CSS, shadcn/ui). Copy `tokens.css` into the app as the global stylesheet layer (e.g. `src/styles/tokens.css`, imported before Tailwind layers or inside `@layer base`).

## 1. shadcn/ui setup

`tokens.css` follows the shadcn CSS-variable convention exactly (`--background`, `--primary`, `--radius`, `.dark` overrides), so `components.json` uses:

```json
{
  "style": "default",
  "tailwind": {
    "baseColor": "stone",
    "cssVariables": true
  }
}
```

All shadcn components then pick up Quorum colors with zero per-component changes. Dark mode: class strategy (`darkMode: ["class"]`), toggled by adding `.dark` to `<html>`; default follows `prefers-color-scheme` with a manual override stored in settings.

## 2. tailwind.config.ts

```ts
import type { Config } from "tailwindcss";

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
        // Quorum expressive accents (personality — never status)
        honey: {
          DEFAULT: "hsl(var(--honey))",
          subtle: "hsl(var(--honey-subtle))",
        },
        plum: {
          DEFAULT: "hsl(var(--plum))",
          subtle: "hsl(var(--plum-subtle))",
        },
        // Quorum status extensions (state — and only state)
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
        lg: "calc(var(--radius) + 6px)",
        md: "var(--radius)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      fontFamily: {
        sans: ["Plus Jakarta Sans", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
      transitionDuration: {
        micro: "140ms",
        DEFAULT: "220ms",
        large: "320ms",
        celebrate: "600ms",
      },
      transitionTimingFunction: {
        enter: "cubic-bezier(0.2, 0, 0, 1)",
        exit: "cubic-bezier(0.4, 0, 1, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      keyframes: {
        "recording-pulse": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.9)" },
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
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
```

Note: if the app is scaffolded on Tailwind v4, express the same mapping via `@theme inline` in CSS instead of `tailwind.config.ts`; token names and values are identical (that is the point of keeping `tokens.css` framework-neutral).

## 3. Fonts (self-hosted, no CDN)

```bash
npm i @fontsource-variable/plus-jakarta-sans @fontsource/jetbrains-mono
```

```ts
// src/main.tsx
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
```

Vite bundles the WOFF2 files into the app; no runtime requests to Google Fonts or any CDN. Subset to `latin` + `latin-ext` initially.

## 4. Usage rules

- Components use semantic Tailwind classes only (`bg-card`, `text-muted-foreground`, `border-border`, `bg-recording`, `bg-honey-subtle`). Never raw palette classes (`bg-red-500`) and never hex values in components.
- `recording` color exclusively for active-capture UI; errors always use `destructive`.
- `honey`/`plum` are expressive only — never to signal success/failure/warning. Honey ≠ `warning`; plum ≠ `info`.
- Status badges: `bg-{status}-subtle text-{status}` (e.g. `bg-info-subtle text-info`).
- Timers/timestamps: `font-mono` (or `tabular-nums` when inline in sans text).
- Playful motion via the shared animation utilities (`animate-rise-in`, `animate-pop-in`, `animate-recording-pulse`, `animate-shimmer`) — no ad-hoc keyframes in components, and every animation honors `prefers-reduced-motion` (handled centrally in `tokens.css`).
- Focus: rely on shadcn's `ring` utilities — do not remove focus outlines.
