# Quorum Design System

Version 2.0 — foundation for V1 (issues #5, #8, #9). Reworked per PO feedback on PR #28: playful but professional. Implementation target: React + Vite PWA with Tailwind CSS + shadcn/ui. Tokens are defined framework-neutral here; see `tokens.css` and `tailwind-tokens.md` for the concrete mapping.

## 1. Brand direction

Quorum records people's words in sensitive meetings — but it should feel like a warm, capable companion, not a compliance appliance. The direction is **"a friendly studio"**: the warmth of a well-lit workspace, the precision of a good tool.

1. **Warm and inviting.** Cream-paper surfaces, rounded shapes, a lively teal with two expressive accents. Users should feel at home and *invited to poke around* — templates, playback, settings all reward exploration. The app is personable, never perfectly corporate.
2. **Playful, but professional.** Personality lives in motion, microcopy, empty states, and celebration moments — never in the data itself. Transcripts, timestamps, statuses, and legal copy are rendered straight. The product can smile; the record cannot.
3. **Honest, always.** Playfulness never buys ambiguity. Every state is explicit and truthful: real buffer counters, real job stages, no fake progress, no optimistic vanishing. Recording state is unmistakable. Delight decorates the truth; it never replaces it.
4. **Data sovereignty.** Self-hosted, private, yours — expressed through candor (the UI shows what the system is really doing) rather than through visual coldness.

### Voice and tone (microcopy)

- Warm, plain, human. Contractions welcome: "You're all set." "That didn't work — want to retry?"
- Celebrate real moments, briefly: "Transcript's ready." Delight is one sentence, not a paragraph.
- Never joke in serious places: consent notice, deletion, errors, and anything legal stay factual and calm (still friendly in rhythm, never flippant).
- State honestly: "Connection lost. Your audio is safe on this device." — reassurance built on facts.
- All strings via i18n (en-US source), never hard-coded. No emoji in product copy; personality comes from words and motion.

## 2. Color

Palette is defined in HSL (shadcn convention) as semantic tokens. Raw values live only in `tokens.css`; components consume semantic tokens exclusively.

### Principles

- **Warm neutral base.** Backgrounds are cream/paper (warm hue cast), text is warm ink — cozy, not clinical white-on-gray.
- **One brand hue, two expressive accents.** Primary is a lively warm teal. Two supporting accents give the product personality: **honey** (warm yellow — highlights, celebration moments, onboarding) and **plum** (soft purple — the identity color of summaries and templates, the "thinking" side of the product). Accents are expressive, not status: they never encode success/failure/warning.
- **Recording red is sacred.** `--recording` is used for exactly one thing: active audio capture (indicator, timer, stop affordances). It is never used for errors — errors use `--destructive`, a visibly different red-orange. A user must be able to tell "I am being recorded" from "something failed" at a glance.
- **Status colors stay unambiguous.** `success`/`warning`/`info`/`destructive` are reserved for state and only state. Honey ≠ warning (different hue and role); plum ≠ info.
- **Dark mode is first-class**: warm charcoal (not blue-black), surfaces lighten as they elevate, all hues re-tuned for contrast.
- All text/background pairs meet WCAG 2.1 AA (≥ 4.5:1 body, ≥ 3:1 large text and UI glyphs).

### Semantic palette (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | hsl(40 45% 97%) | hsl(25 14% 10%) | App background (cream / warm charcoal) |
| `foreground` | hsl(25 30% 14%) | hsl(35 20% 92%) | Body text (warm ink) |
| `card` | hsl(0 0% 100%) | hsl(25 12% 14%) | Cards, sheets |
| `card-foreground` | hsl(25 30% 14%) | hsl(35 20% 92%) | Text on cards |
| `popover` | hsl(0 0% 100%) | hsl(25 12% 16%) | Menus, popovers |
| `popover-foreground` | hsl(25 30% 14%) | hsl(35 20% 92%) | |
| `primary` | hsl(172 58% 28%) | hsl(170 50% 55%) | Brand teal — primary actions, active nav, links |
| `primary-foreground` | hsl(0 0% 100%) | hsl(25 25% 10%) | |
| `secondary` | hsl(40 30% 92%) | hsl(25 10% 20%) | Secondary buttons, subtle fills |
| `secondary-foreground` | hsl(25 30% 18%) | hsl(35 18% 88%) | |
| `muted` | hsl(40 30% 93%) | hsl(25 10% 18%) | Muted fills, skeletons |
| `muted-foreground` | hsl(25 12% 42%) | hsl(30 10% 64%) | Secondary text, timestamps |
| `accent` | hsl(172 45% 91%) | hsl(172 35% 20%) | Hover fills, selected list rows |
| `accent-foreground` | hsl(172 60% 18%) | hsl(170 45% 80%) | |
| `destructive` | hsl(9 72% 44%) | hsl(9 70% 60%) | Errors, delete actions |
| `destructive-foreground` | hsl(0 0% 100%) | hsl(25 25% 10%) | |
| `border` | hsl(35 25% 87%) | hsl(25 10% 24%) | Hairlines |
| `input` | hsl(35 25% 82%) | hsl(25 10% 28%) | Input borders |
| `ring` | hsl(172 58% 34%) | hsl(170 50% 55%) | Focus rings |

### Expressive accents (personality, never status)

| Token | Light | Dark | Use |
|---|---|---|---|
| `honey` | hsl(42 92% 40%) | hsl(44 90% 62%) | Celebration moments, onboarding highlights, empty-state art, "new" markers |
| `honey-subtle` | hsl(45 90% 92%) | hsl(42 45% 16%) | Tinted surfaces for the above |
| `plum` | hsl(285 40% 42%) | hsl(285 45% 70%) | Summary/template identity: summary tab accents, template editor art, section markers |
| `plum-subtle` | hsl(288 45% 94%) | hsl(285 30% 18%) | Tinted surfaces for the above |

### Status colors (state, and only state)

| Token | Light | Dark | Use |
|---|---|---|---|
| `recording` | hsl(0 78% 45%) | hsl(0 75% 62%) | Active recording only |
| `recording-foreground` | hsl(0 0% 100%) | hsl(25 25% 10%) | |
| `success` | hsl(152 48% 30%) | hsl(152 42% 54%) | Ready/complete states |
| `warning` | hsl(28 88% 38%) | hsl(30 85% 60%) | Offline, buffering, degraded (orange — distinct from honey yellow) |
| `info` | hsl(215 62% 42%) | hsl(213 65% 68%) | Processing/queued, neutral status |

Each status color has a paired `-subtle` surface tint for badges (see `tokens.css`): text at full status color on a ~10–15% tinted background of the same hue.

## 3. Typography

**Self-hosting requirement:** no font CDNs at runtime. Both families are SIL Open Font License 1.1; ship WOFF2 subsets in the app bundle (e.g. via `@fontsource` npm packages, bundled by Vite).

| Role | Face | Fallback stack |
|---|---|---|
| UI & body (`--font-sans`) | **Plus Jakarta Sans** (variable) | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Timestamps, durations, seq/debug (`--font-mono`) | **JetBrains Mono** | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Plus Jakarta Sans is a rounded geometric humanist — friendly and open at display sizes, crisp and professional at text sizes; a natural fit for "playful but professional". Use `font-feature-settings: "tnum"` wherever numerals sit inline in sans text (durations in list rows) so timers never jitter. Recording timers use the mono face.

### Type scale (mobile-first; rem, base 16px)

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `text-xs` | 0.75rem / 1rem | 400–500 | Badges, meta, timestamps |
| `text-sm` | 0.875rem / 1.25rem | 400 | Secondary text, list meta, form help |
| `text-base` | 1rem / 1.5rem | 400 | Body, transcript text |
| `text-lg` | 1.125rem / 1.75rem | 600 | Card titles, section heads |
| `text-xl` | 1.25rem / 1.75rem | 700 | Screen titles (mobile) |
| `text-2xl` | 1.5rem / 2rem | 700 | Screen titles (≥ md), summary H1 |
| `text-3xl` | 1.875rem / 2.25rem | 700 | Empty-state and onboarding headlines |
| `text-timer` | 2.25rem / 1 | 500 mono, tabular | Recording timer |

Headings lean bolder (600/700) than v1 — Plus Jakarta Sans carries weight warmly rather than sternly. Max line length for transcript/summary prose: `65ch`.

## 4. Spacing, radius, elevation

### Spacing

4px base grid, Tailwind's default scale (`0.5`=2px … `4`=16px, `6`=24px, `8`=32px, `12`=48px). Rules:

- Screen gutter: 16px mobile, 24px ≥ md.
- Card padding: 16px mobile, 20–24px ≥ md.
- Vertical rhythm between stacked cards/list items: 8–12px.
- Touch targets ≥ 44×44px; primary recording controls ≥ 64px.

### Radius — soft and round

Roundness is a core part of the warmth. Pills are common (badges, filters, player controls).

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 10px | Badges, inputs (calc: radius − 4px) |
| `--radius` | 14px | Buttons, cards (shadcn base) |
| `--radius-lg` | 20px | Dialogs, sheets, empty-state cards |
| `--radius-full` | 9999px | Record button, avatars, pills, player buttons |

### Elevation

Soft-shadow-first: warm, diffuse shadows (shadow color derived from the warm ink, never pure black in light mode) give surfaces a gentle lift. Borders remain for definition on dense UI.

| Token | Use | Value (light) |
|---|---|---|
| `--shadow-sm` | Cards, list rows | `0 1px 3px hsl(25 30% 14% / 0.07), 0 1px 2px hsl(25 30% 14% / 0.05)` |
| `--shadow-md` | Popovers, dropdowns, hover lift | `0 6px 16px hsl(25 30% 14% / 0.10)` |
| `--shadow-lg` | Dialogs, sheets | `0 16px 40px hsl(25 30% 14% / 0.16)` |

Dark mode: elevation expressed primarily by lighter surface color; shadows subtle.

## 5. Motion — a real motion language

Motion is a first-class part of Quorum's personality: it welcomes, acknowledges, and celebrates. One hard rule carries over from the honest-state principle: **motion may decorate state, but state must never be conveyed — or obscured — by motion alone.** Every animated state also has an icon + label.

### Durations & easing

| Token | Value | Use |
|---|---|---|
| `--duration-micro` | 140ms | Hover, press, toggles |
| `--duration-default` | 220ms | Fades, popovers, badge changes |
| `--duration-large` | 320ms | Sheets, dialogs, route transitions |
| `--duration-celebrate` | 600ms | Arrival moments (ready states) — the only tier allowed above 400ms |
| `--ease-enter` | `cubic-bezier(0.2, 0, 0, 1)` | Entrances, decelerate |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Exits |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful overshoot: press feedback, badge flips, arrival pops |

### The micro-interaction catalog

Implement these consistently (utilities in `tokens.css` / Tailwind config):

- **Button press:** scale to 0.97 on press, spring back on release (`--ease-spring`). Primary buttons get a soft shadow lift on hover.
- **List enter:** meeting rows fade + rise 8px with a 30ms stagger (cap the stagger at 10 items). Deleted rows collapse height after the server confirms.
- **Badge state change:** old badge flips out (scale 0.8 + fade), new one springs in — a visible "the state really changed" beat.
- **Recording indicator:** the "breathing dot" — see COMPONENTS.md §3. It pulses with a heartbeat rhythm and, where input level is available, subtly scales with the live audio level: the app visibly *listens*. Personality and honesty in one element.
- **Arrival moments:** when a transcript or summary flips to Ready while the user is looking: the tab dot pops (spring scale 0→1 in honey), the content area does a staggered rise-in of its first segments/sections, and the status badge springs to `success`. One celebration per arrival — no looping, no confetti storms; a single warm beat.
- **Record button:** idle→recording morph (circle → rounded square) over 320ms with spring; the morph is the "it's real now" moment.
- **Processing:** the pipeline stepper (STATES.md §4) animates the active stage with a gentle shimmer; determinate progress fills with `--ease-enter`.
- **Empty states:** spot illustration drifts in (rise + fade) once per mount; no looping ambient motion except the recording pulse.

### Rules

- Ambient/looping motion is reserved for genuinely live things: the recording pulse and active-job shimmer. Everything else animates on transition only.
- Never animate during audio capture in ways that suggest capture stopped (no pausing the pulse for a celebration).
- Motion must never delay interaction: elements are interactive immediately; animation is cosmetic overlay.
- Celebrations are strictly visual — no sound, no haptics, on any platform. Quorum is used in and around live meetings; the app never makes noise.
- **`prefers-reduced-motion`:** all transitions collapse to fades ≤ 120ms or none; pulse becomes a static solid dot + "REC" label; celebrations become an instant badge change. State is always carried by icon + text.

## 6. Iconography & illustration

[Lucide](https://lucide.dev) (ISC license, ships with shadcn/ui). 20px default in dense UI, 24px in nav/controls. Stroke width 2 (1.75 at small sizes). Key mappings: `Mic` record, `Square` stop, `Pause`/`Play`, `FileText` transcript, `ScrollText` summary, `CloudOff` offline, `Loader2` processing (spin), `Trash2` delete, `Settings`, `ListChecks` templates, `Sparkles` arrival moments.

**Empty-state visuals** (empty states, onboarding): no illustrations, no abstract shapes, no characters. The visual is a single large Lucide icon (48px, `stroke-width 1.75`) in a soft rounded container — a `--radius-lg` tile filled with `honey-subtle` (or `plum-subtle` for template contexts), icon stroked in `honey`/`plum`. Warmth comes from color, radius, typography, and the existing motion language (staggered rise-in) — not from figures. Everything themes via tokens for dark mode.

**Mascot: evaluated and rejected.** A mascot character (blob figure with a face) was prototyped for the empty states and rejected by the PO — it does not meet the quality bar and is out of scope, not deferred. Do not reintroduce characters or organic blob artwork; the icon-tile pattern above is the standard for empty-state visuals.

## 7. Accessibility baseline

- WCAG 2.1 AA contrast; verified for all token pairs above (expressive accents included).
- Every state (recording, offline, processing, failed) is conveyed by icon + text + color — never color or motion alone.
- Focus visible everywhere (`ring` token, 2px offset).
- Recording state changes are announced via `aria-live="assertive"`; job status changes via `aria-live="polite"`.
- Full keyboard operability; dialogs trap focus (Radix defaults via shadcn).
- All playful motion honors `prefers-reduced-motion` (see §5).
