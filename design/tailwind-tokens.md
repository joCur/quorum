# Token mapping: Tailwind CSS + shadcn/ui

How `tokens.css` maps into the frontend stack (React + Vite PWA, Tailwind CSS, shadcn/ui). Copy `tokens.css` into the app as the global stylesheet layer (e.g. `src/styles/tokens.css`, imported before Tailwind layers or inside `@layer base`).

## 1. shadcn/ui setup

`tokens.css` follows the shadcn CSS-variable convention exactly (`--background`, `--primary`, `--radius`, `.dark` overrides), so `components.json` uses:

```json
{
  "style": "default",
  "tailwind": {
    "baseColor": "slate",
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
        // Quorum status extensions
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
        lg: "calc(var(--radius) + 4px)",
        md: "var(--radius)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
      transitionDuration: {
        micro: "120ms",
        DEFAULT: "200ms",
        large: "300ms",
      },
      transitionTimingFunction: {
        enter: "cubic-bezier(0.2, 0, 0, 1)",
        exit: "cubic-bezier(0.4, 0, 1, 1)",
      },
      keyframes: {
        "recording-pulse": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.92)" },
        },
      },
      animation: {
        "recording-pulse": "recording-pulse 2s cubic-bezier(0.2, 0, 0, 1) infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
```

Note: if the app is scaffolded on Tailwind v4, express the same mapping via `@theme inline` in CSS instead of `tailwind.config.ts`; token names and values are identical (that is the point of keeping `tokens.css` framework-neutral).

## 3. Fonts (self-hosted, no CDN)

```bash
npm i @fontsource-variable/inter @fontsource/jetbrains-mono
```

```ts
// src/main.tsx
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
```

Vite bundles the WOFF2 files into the app; no runtime requests to Google Fonts or any CDN. Subset to `latin` + `latin-ext` initially.

## 4. Usage rules

- Components use semantic Tailwind classes only (`bg-card`, `text-muted-foreground`, `border-border`, `bg-recording`). Never raw palette classes (`bg-red-500`) and never hex values in components.
- `recording` color exclusively for active-capture UI; errors always use `destructive`.
- Status badges: `bg-{status}-subtle text-{status}` (e.g. `bg-info-subtle text-info`).
- Timers/timestamps: `font-mono` (or `tabular-nums` when inline in sans text).
- Focus: rely on shadcn's `ring` utilities — do not remove focus outlines.
