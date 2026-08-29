# Quorum Design System

Version 1.0 — foundation for V1 (issues #5, #8, #9). Implementation target: React + Vite PWA with Tailwind CSS + shadcn/ui. Tokens are defined framework-neutral here; see `tokens.css` and `tailwind-tokens.md` for the concrete mapping.

## 1. Brand direction

Quorum is a tool people bring into sensitive meetings. Everything on screen must communicate three things:

1. **Trust.** The user is recording other people's words. The UI never surprises, never hides state, and never uses dark patterns. Destructive actions are explicit; recording state is unmistakable.
2. **Data sovereignty.** Self-hosted, private, yours. The visual language is understated and precise — closer to an instrument panel than a consumer social app. We show the system's real state (buffered chunks, job progress, deletion confirmation) instead of papering over it with optimistic UI.
3. **Calm professionalism.** Sober, quiet surfaces. Generous whitespace, restrained color, no playful illustration, no gradients-as-decoration, no emoji in product copy. Color is reserved for *meaning* (recording, errors, sync state), so when it appears, it matters.

### Voice and tone (microcopy)

- Plain, factual, short sentences. "Recording saved. Transcription queued." — not "Awesome! We're working our magic ✨".
- State honestly: "Connection lost. Audio is being saved on this device." beats "Reconnecting…" alone.
- Legal/consent copy is never minimized visually; it is part of the product, not a compliance afterthought.
- All strings via i18n (en-US source), never hard-coded.

## 2. Color

Palette is defined in HSL (shadcn convention) as semantic tokens. Raw values live only in `tokens.css`; components consume semantic tokens exclusively.

### Principles

- **Neutral-first.** ~95% of any screen is neutral (slate-tinted grays). The cool slate cast reads technical and calm.
- **One brand hue.** A deep, desaturated teal (`--primary`) — trustworthy, distinct from the alarm-red of recording and the blues that read "generic SaaS".
- **Recording red is sacred.** `--recording` is used for exactly one thing: active audio capture (indicator, timer, stop affordances). It is never used for errors — errors use `--destructive`, a visibly different red-orange. A user must be able to tell "I am being recorded" from "something failed" at a glance.
- **Dark mode is first-class**, not an inversion. Surfaces lighten as they elevate; the brand teal and status colors are re-tuned for contrast on dark backgrounds.
- All text/background pairs meet WCAG 2.1 AA (≥ 4.5:1 for body, ≥ 3:1 for large text and UI glyphs).

### Semantic palette (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | hsl(220 20% 98%) | hsl(222 18% 9%) | App background |
| `foreground` | hsl(222 25% 12%) | hsl(220 15% 92%) | Body text |
| `card` | hsl(0 0% 100%) | hsl(222 16% 13%) | Cards, sheets |
| `card-foreground` | hsl(222 25% 12%) | hsl(220 15% 92%) | Text on cards |
| `popover` | hsl(0 0% 100%) | hsl(222 16% 15%) | Menus, popovers |
| `popover-foreground` | hsl(222 25% 12%) | hsl(220 15% 92%) | |
| `primary` | hsl(190 65% 26%) | hsl(188 55% 55%) | Brand teal — primary actions, active nav, links |
| `primary-foreground` | hsl(0 0% 100%) | hsl(222 25% 10%) | |
| `secondary` | hsl(220 15% 93%) | hsl(222 14% 19%) | Secondary buttons, subtle fills |
| `secondary-foreground` | hsl(222 25% 16%) | hsl(220 15% 88%) | |
| `muted` | hsl(220 15% 94%) | hsl(222 14% 17%) | Muted fills, skeletons |
| `muted-foreground` | hsl(220 10% 42%) | hsl(220 10% 62%) | Secondary text, timestamps |
| `accent` | hsl(190 50% 92%) | hsl(190 40% 20%) | Hover fills, selected list rows |
| `accent-foreground` | hsl(190 65% 18%) | hsl(188 55% 80%) | |
| `destructive` | hsl(9 72% 44%) | hsl(9 70% 58%) | Errors, delete actions |
| `destructive-foreground` | hsl(0 0% 100%) | hsl(222 25% 10%) | |
| `border` | hsl(220 14% 88%) | hsl(222 12% 24%) | Hairlines |
| `input` | hsl(220 14% 84%) | hsl(222 12% 28%) | Input borders |
| `ring` | hsl(190 65% 32%) | hsl(188 55% 55%) | Focus rings |

### Status colors (product-specific extensions)

| Token | Light | Dark | Use |
|---|---|---|---|
| `recording` | hsl(0 78% 45%) | hsl(0 75% 60%) | Active recording only |
| `recording-foreground` | hsl(0 0% 100%) | hsl(222 25% 10%) | |
| `success` | hsl(152 45% 32%) | hsl(152 42% 52%) | Ready/complete states |
| `warning` | hsl(38 85% 38%) | hsl(40 85% 58%) | Offline, buffering, degraded |
| `info` | hsl(215 60% 42%) | hsl(213 65% 65%) | Processing/queued, neutral status |

Each status color has a paired `-subtle` surface tint for badges (see `tokens.css`): text at full status color on a ~10–15% tinted background of the same hue.

## 3. Typography

**Self-hosting requirement:** no font CDNs at runtime. Both families are SIL Open Font License 1.1; ship WOFF2 subsets in the app bundle (e.g. via `@fontsource` npm packages, bundled by Vite).

| Role | Face | Fallback stack |
|---|---|---|
| UI & body (`--font-sans`) | **Inter** (variable) | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Timestamps, durations, seq/debug (`--font-mono`) | **JetBrains Mono** | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Inter with `font-feature-settings: "cv05", "tnum"` for timestamps rendered in sans contexts (tabular numerals prevent timer jitter). Recording timers use the mono face.

### Type scale (mobile-first; rem, base 16px)

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `text-xs` | 0.75rem / 1rem | 400–500 | Badges, meta, timestamps |
| `text-sm` | 0.875rem / 1.25rem | 400 | Secondary text, list meta, form help |
| `text-base` | 1rem / 1.5rem | 400 | Body, transcript text |
| `text-lg` | 1.125rem / 1.75rem | 500 | Card titles, section heads |
| `text-xl` | 1.25rem / 1.75rem | 600 | Screen titles (mobile) |
| `text-2xl` | 1.5rem / 2rem | 600 | Screen titles (≥ md), summary H1 |
| `text-3xl` | 1.875rem / 2.25rem | 600 | Rare: empty-state headlines |
| `text-timer` | 2.25rem / 1 | 500 mono, tabular | Recording timer |

Headings use weight (500/600), not size alone, to establish hierarchy. Max line length for transcript/summary prose: `65ch`.

## 4. Spacing, radius, elevation

### Spacing

4px base grid, Tailwind's default scale (`0.5`=2px … `4`=16px, `6`=24px, `8`=32px, `12`=48px). Rules:

- Screen gutter: 16px mobile, 24px ≥ md.
- Card padding: 16px mobile, 20–24px ≥ md.
- Vertical rhythm between stacked cards/list items: 8–12px.
- Touch targets ≥ 44×44px; primary recording controls ≥ 64px.

### Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 6px | Badges, inputs (calc: radius − 4px) |
| `--radius` | 10px | Buttons, cards (shadcn base) |
| `--radius-lg` | 14px | Dialogs, sheets |
| `--radius-full` | 9999px | Record button, avatars, pills |

### Elevation

Flat-first: prefer borders over shadows. Shadows only for genuinely floating layers.

| Token | Use | Value (light) |
|---|---|---|
| `--shadow-sm` | Cards on hover, sticky bars | `0 1px 2px hsl(222 25% 12% / 0.06)` |
| `--shadow-md` | Popovers, dropdowns | `0 4px 12px hsl(222 25% 12% / 0.10)` |
| `--shadow-lg` | Dialogs, sheets | `0 12px 32px hsl(222 25% 12% / 0.16)` |

Dark mode: elevation is expressed primarily by lighter surface color (`card` → `popover`), shadows kept subtle.

## 5. Motion

Motion communicates state, never decorates.

- **Durations:** 120ms (micro: hover, press), 200ms (default: fades, popovers), 300ms (large: sheets, dialogs, route transitions). Nothing over 400ms.
- **Easing:** `cubic-bezier(0.2, 0, 0, 1)` (decelerate) for entrances; `cubic-bezier(0.4, 0, 1, 1)` for exits.
- **The recording pulse** is the one deliberate ambient animation: a 2s soft opacity/scale pulse on the recording indicator. It must run only while audio is actually being captured — never during "paused" or "connecting". Honest motion is part of the trust promise.
- **Processing** uses indeterminate motion (subtle spinner / animated badge dot) only while a job is genuinely `queued`/`running`; determinate progress bars when `progress` is reported.
- **`prefers-reduced-motion`:** disable the pulse (replace with a static solid dot + "REC" label), disable all non-essential transitions. State must never be conveyed by motion alone.

## 6. Iconography

[Lucide](https://lucide.dev) (ISC license, ships with shadcn/ui). 20px default in dense UI, 24px in nav/controls. Stroke width 2 (1.75 at small sizes). Key mappings: `Mic` record, `Square` stop, `Pause`/`Play`, `FileText` transcript, `ScrollText` summary, `CloudOff` offline, `Loader2` processing (spin), `Trash2` delete, `Settings`, `ListChecks` templates.

## 7. Accessibility baseline

- WCAG 2.1 AA contrast; verified for all token pairs above.
- Every state (recording, offline, processing, failed) is conveyed by icon + text + color — never color alone.
- Focus visible everywhere (`ring` token, 2px offset).
- Recording state changes are announced via `aria-live="assertive"`; job status changes via `aria-live="polite"`.
- Full keyboard operability; dialogs trap focus (Radix defaults via shadcn).
