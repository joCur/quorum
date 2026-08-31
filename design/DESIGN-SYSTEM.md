# Quorum Design System

Version 3.0 — the "Paper / Espresso / Honey" world. Implementation target: React + Vite PWA with
Tailwind CSS + shadcn/ui. Tokens are defined framework-neutral here; see `tokens.css` and
`tailwind-tokens.md` for the concrete mapping.

This document is the aesthetic source of truth. The behavioral rules that govern how states are
shown live in `STATES.md` and are binding independently of the visual language — a repaint never
changes what the product is allowed to claim.

## 1. Brand direction

Quorum records people's words in sensitive meetings — but it should feel like a warm, capable
companion, not a compliance appliance. The direction is **editorial warmth**: warm paper, a dark
espresso voice, one honey accent, and generous roundness. Less "app chrome", more "a good notebook
that writes back".

1. **Warm and quiet.** Paper surfaces, espresso ink, hairline borders, soft shadows. The interface
   recedes so the words in the meeting can be the loudest thing on screen.
2. **One accent, used with intent.** Honey is the only expressive color. It marks the brand, the
   selection, the highlighted word, the section that matters. Because there is exactly one, it
   still means something when it appears.
3. **Playful, but professional.** Personality lives in motion, microcopy, empty states, and arrival
   moments — never in the data itself. Transcripts, timestamps, statuses, and legal copy are
   rendered straight. The product can smile; the record cannot.
4. **Honest, always.** Playfulness never buys ambiguity. Every state is explicit and truthful: real
   buffer counters, real job stages, no fake progress, no optimistic vanishing. Recording state is
   unmistakable. Delight decorates the truth; it never replaces it.
5. **Data sovereignty.** Private, yours — expressed through candor (the UI shows what the system is
   really doing) rather than through visual coldness.

### Voice and tone (microcopy)

- Warm, plain, human. Contractions welcome: "You're all set." "That didn't work — want to retry?"
- Celebrate real moments, briefly: "Transcript's ready." Delight is one sentence, not a paragraph.
- Never joke in serious places: the consent notice, deletion, errors, and anything legal stay
  factual and calm (still friendly in rhythm, never flippant).
- State honestly: "Connection lost. Your audio is safe on this device." — reassurance built on facts.
- All strings via i18n (en-US source), never hard-coded. No emoji in product copy; personality comes
  from words and motion.

## 2. Color

The palette is defined in HSL (shadcn convention) as semantic tokens. Raw values live only in
`tokens.css`; components consume semantic tokens exclusively.

### Principles

- **Paper base, espresso ink.** Backgrounds are warm paper, text is dark espresso. Cards sit a
  half-step brighter than the page rather than pure white.
- **The action color flips with the theme.** In light mode the primary action is **espresso** — a
  near-black warm brown, so a button reads as a confident piece of ink on the page. In dark mode the
  primary action is **honey**, because espresso disappears into a dark ground. Both are `--primary`;
  no component needs to know which.
- **Honey is the single expressive accent.** It carries the brand dot, selection, the transcript
  word highlight, and the summary section underline. Honey comes in three steps: `honey` (the fill),
  `honey-strong` (the readable-on-paper variant used for text, icons, links and focus rings), and
  `honey-subtle` (the tint). **There is no second expressive accent** — the previous plum is gone.
- **Recording red is sacred.** `--recording` is used for exactly one thing: active audio capture
  (indicator, timer, stop affordances). It is never used for errors — errors use `--destructive`, a
  visibly different red. A user must be able to tell "I am being recorded" from "something failed"
  at a glance.
- **Status colors stay unambiguous.** `success`/`warning`/`info`/`destructive` are reserved for
  state and only state. Honey is never `warning`, even though both are warm.
- **Dark mode is first-class**: warm near-black (not blue-black), surfaces lighten as they elevate,
  all hues re-tuned for contrast.
- Text/background pairs are measured, not assumed — see §7 for the two light-mode tint pairings that
  currently fall short of AA for small text. Note that `honey` itself does **not** pass as body text
  on paper at all (1.8:1) — that is what `honey-strong` is for.

### Semantic palette (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | hsl(38 50% 96%) | hsl(26 18% 9%) | App background (paper / warm near-black) |
| `foreground` | hsl(26 30% 12%) | hsl(38 25% 92%) | Body text (espresso ink) |
| `card` | hsl(40 40% 99%) | hsl(26 15% 13%) | Panels, cards, sheets |
| `card-foreground` | hsl(26 30% 12%) | hsl(38 25% 92%) | Text on cards |
| `popover` | hsl(40 40% 99%) | hsl(26 15% 13%) | Menus, popovers |
| `popover-foreground` | hsl(26 30% 12%) | hsl(38 25% 92%) | |
| `primary` | hsl(26 30% 16%) | hsl(42 92% 55%) | **Espresso** light / **honey** dark — primary actions, the brand mark |
| `primary-foreground` | hsl(40 50% 96%) | hsl(26 30% 10%) | |
| `secondary` | hsl(40 40% 99%) | hsl(26 15% 13%) | Secondary buttons: panel fill plus a hairline border |
| `secondary-foreground` | hsl(26 30% 12%) | hsl(38 25% 92%) | |
| `muted` | hsl(38 50% 96%) | hsl(26 18% 9%) | Neutral fills inside a panel (track fills, neutral chips) |
| `muted-foreground` | hsl(28 12% 42%) | hsl(32 10% 62%) | Secondary text, timestamps |
| `accent` | hsl(44 95% 90%) | hsl(40 40% 17%) | Selection and hover fills — honey, not a tint of primary |
| `accent-foreground` | hsl(36 85% 36%) | hsl(44 85% 66%) | |
| `destructive` | hsl(5 70% 44%) | hsl(5 70% 62%) | Errors, delete actions |
| `destructive-foreground` | hsl(0 0% 100%) | hsl(26 30% 10%) | |
| `border` | hsl(34 25% 86%) | hsl(26 12% 22%) | Hairlines |
| `input` | hsl(34 25% 86%) | hsl(26 12% 22%) | Input borders — the same hairline as `border` |
| `ring` | hsl(36 85% 36%) | hsl(44 85% 66%) | Focus rings (honey-strong) |

`secondary` and `muted` have no dedicated fill in the reference: secondary surfaces are the panel
color with a hairline, and muted fills are the page color used inside a panel. They are mapped that
way rather than invented, so a component asking for either lands on a real surface.

### The expressive accent (personality, never status)

| Token | Light | Dark | Use |
|---|---|---|---|
| `honey` | hsl(42 92% 50%) | hsl(44 90% 58%) | Fills: the brand dot, progress fill, the word-highlight tint at low alpha |
| `honey-strong` | hsl(36 85% 36%) | hsl(44 85% 66%) | Text, icons, links, focus rings — the readable variant |
| `honey-subtle` | hsl(44 95% 90%) | hsl(40 40% 17%) | Tinted surfaces: selection, icon tiles, the "Default" chip |
| `brand-dot` | hsl(42 92% 55%) | hsl(26 30% 10%) | The dot on the Q mark. Honey on espresso in light, espresso on honey in dark |

### On-air identity

The recording screen follows the theme like every other screen — a light-theme user gets a light
recording screen. There is therefore no dedicated on-air surface token: the screen stands on
`background` / `foreground`, and what marks it as a different place is its layout, the `REC` pill,
the level bars and the hold-to-stop ring.

The one exception is the landing's on-air tile (`on-air`, `on-air-foreground`, `on-air-muted`),
which stays dark in both themes. It is a *picture* of a running capture shown to a signed-out
visitor, not a surface anyone is working on, and the rule above is about the screens people use.

### Status colors (state, and only state)

| Token | Light | Dark | Use |
|---|---|---|---|
| `recording` | hsl(4 78% 46%) | hsl(4 75% 58%) | Active recording only |
| `recording-foreground` | hsl(0 0% 100%) | hsl(26 25% 8%) | |
| `success` | hsl(152 46% 30%) | hsl(152 42% 54%) | Ready/complete states |
| `warning` | hsl(29 86% 38%) | hsl(30 85% 60%) | Offline, buffering, degraded |
| `info` | hsl(213 60% 42%) | hsl(213 65% 68%) | Processing/queued, neutral status |

Each status color has a paired `-subtle` surface tint for badges (see `tokens.css`): text at full
status color on a tinted background of the same hue.

## 3. Typography

Two faces carry the product, plus mono for time. **Self-hosting requirement:** no font CDNs at
runtime. All three families are SIL Open Font License 1.1; ship WOFF2 subsets in the app bundle via
`@fontsource` npm packages, bundled by Vite.

| Role | Face | Weights shipped | Fallback stack |
|---|---|---|---|
| Display (`--font-display`) | **Schibsted Grotesk** | 500, 700, 800, 900 | `"Figtree", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| UI & body (`--font-sans`) | **Figtree** | 400, 500, 600, 700 | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Timestamps, durations, seq/debug (`--font-mono`) | **JetBrains Mono** | 400, 500 | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Schibsted Grotesk is a tight editorial grotesque that gets characterful as it gets heavier — it is
what makes a headline feel set rather than typed. It is used for headings, the Q mark, dialog
titles, and summary section titles; at those sizes it takes negative tracking (about `-0.025em`, up
to `-0.03em` on the largest display sizes). It is **not** used for body copy or UI labels.

Figtree carries everything else: body text, buttons, form labels, list rows. It is open and quiet at
text sizes and does not compete with the display face.

Use `font-feature-settings: "tnum"` wherever numerals sit inline in sans text (durations in list
rows) so timers never jitter. Recording timers and timestamps use the mono face at weight 500 with
`font-variant-numeric: tabular-nums`.

### Type scale (mobile-first; rem, base 16px)

| Token | Size / line-height | Face / weight | Use |
|---|---|---|---|
| `text-xs` | 0.75rem / 1rem | sans 500–700 | Badges, meta, form help emphasis |
| `text-section-label` | 0.75rem / 1rem | 800, `0.08em` tracking | Uppercase labels naming a group or a panel |
| `text-sm` | 0.875rem / 1.25rem | sans 400–600 | Secondary text, list meta, form help |
| `text-base` | 1rem / 1.5rem | sans 400 | Body, transcript text |
| `text-lg` | 1.125rem / 1.75rem | display 700 | Card titles, summary section heads |
| `text-xl` | 1.25rem / 1.75rem | display 800 | Dialog titles |
| `text-display-sm` | 1.75rem / 1.5 | display 800, `-0.025em` | Title of one opened record: a meeting, a template in the editor |
| `text-display-md` | 1.875rem / 1.5 | display 800, `-0.025em` | Recording screen title |
| `text-3xl` | 1.875rem / 2.25rem | display 800 | Empty-state and onboarding headlines |
| `text-display-lg` | 2rem / 1.5 | display 800, `-0.025em` | Screen title: meetings, templates, settings |
| display hero | `clamp(2.5rem, 6.5vw, 4.5rem)` / 1.02 | display 900, `-0.03em` | Landing hero only |
| `text-timer` | 2.25rem / 1 | mono 500, tabular | Recording timer |

The three `text-display-*` steps hold their size at every viewport width — a screen title does not
shrink on a phone. Each token carries size, leading, weight and tracking together, so a heading is a
single class; the display face itself comes from the `h1`/`h2`/`h3` base rule.

Max line length for transcript/summary prose: `65ch`.

## 4. Spacing, radius, elevation

### Spacing

4px base grid, Tailwind's default scale (`0.5`=2px … `4`=16px, `6`=24px, `8`=32px, `12`=48px). Rules:

- Screen gutter: 16px mobile, 24px ≥ md.
- Card padding: 16px mobile, 20–28px ≥ md.
- Vertical rhythm between stacked cards/list items: 8–12px.
- Touch targets ≥ 44×44px; primary recording controls ≥ 64px.

### Radius — pills and generous cards

Roundness is a core part of the warmth, and v2 pushes it further: **every control is a pill.**
Buttons, nav items, chips, badges, search fields, the rate selector — all `999px`. Cards are
generous but not circular, landing between 16 and 22px. Fields (text inputs, selects, textareas) are
the one place with a modest radius, because a pill-shaped multi-line input reads badly.

| Token | Value | Use |
|---|---|---|
| `--radius-pill` | 999px | Every control: buttons, nav pills, badges, chips, search, player bar |
| `--radius-field-sm` | 10px | Small inline fields, icon-button hit areas |
| `--radius-field` | 12px | Text inputs, selects, textareas |
| `--radius-card-sm` | 16px | Inline callouts, alert cards, editor section cards |
| `--radius-card` | 18px | The default panel and card radius |
| `--radius-card-lg` | 22px | Dialogs, sheets, the auth panel |

`--radius` is the shadcn base and equals `--radius-card` (18px). The shadcn steps map to real token
values rather than computed offsets: `rounded-lg` → `--radius-card-lg`, `rounded-md` → `--radius`,
`rounded-sm` → `--radius-field-sm`.

### Elevation

Soft-shadow-first: warm, diffuse shadows (shadow color derived from the espresso ink, never pure
black in light mode) give surfaces a gentle lift. Hairline borders remain for definition on dense UI
— most panels carry *both* a border and `--shadow-sm`.

| Token | Use | Value (light) |
|---|---|---|
| `--shadow-sm` | Cards, list rows, the player bar | `0 1px 3px hsl(26 30% 12% / 0.07), 0 1px 2px hsl(26 30% 12% / 0.05)` |
| `--shadow-md` | Popovers, dropdowns, hover lift, the brand mark | `0 6px 16px hsl(26 30% 12% / 0.10)` |
| `--shadow-lg` | Dialogs and sheets | `0 16px 40px hsl(26 30% 12% / 0.16)` |

Dark mode: elevation is expressed primarily by lighter surface color; shadows fall back to plain
black at higher alpha (`0 4px 12px hsl(0 0% 0% / 0.4)` for `--shadow-md`).

## 5. Motion — a real motion language

Motion is a first-class part of Quorum's personality: it welcomes, acknowledges, and celebrates. One
hard rule carries over from the honest-state principle: **motion may decorate state, but state must
never be conveyed — or obscured — by motion alone.** Every animated state also has an icon + label.

### Durations & easing

| Token | Value | Use |
|---|---|---|
| `--duration-micro` | 140ms | Hover, press, toggles |
| `--duration-default` | 220ms | Rise-in, fades, popovers, badge changes |
| `--duration-large` | 320ms | Sheets, dialogs, route transitions, panel entrances |
| `--duration-celebrate` | 600ms | Arrival moments (ready states) — the only tier allowed above 400ms |
| `--duration-hold-to-stop` | 1200ms | The hold-to-stop ring (interaction motion, see below) |
| `--ease-enter` | `cubic-bezier(0.2, 0, 0, 1)` | Entrances, decelerate |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Exits |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful overshoot: press feedback, badge flips, arrival pops |

### The micro-interaction catalog

Implement these consistently (utilities in `tokens.css` / Tailwind config):

- **Rise-in (220ms, `--ease-enter`):** arriving content fades and rises 8px. Meeting rows, summary
  sections, alert banners, and empty-state art all use it, with a 30ms stagger capped at 10 items.
  Larger surfaces (the auth panel, a sheet) use the 320ms tier.
- **Pop-in (220ms, `--ease-spring`):** a state that really changed — the "Ready" badge, the tab dot,
  a newly added editor section — springs from scale 0.6.
- **Button press:** scale to 0.97 on press, spring back on release. Primary buttons get a soft
  shadow lift on hover.
- **Recording pulse (1.6s loop, `--ease-enter`):** the "breathing dot" — see COMPONENTS.md. It
  pulses between opacity 1/scale 1 and opacity 0.5/scale 0.85 and, where input level is available,
  subtly scales with the live audio level: the app visibly *listens*.
- **Active-stage shimmer (1.8s linear loop):** a gentle gradient sweep across the badge of the one
  pipeline stage that is actually running.
- **Hold-to-stop ring:** stopping a recording is a 1.2s press-and-hold; a conic-gradient ring fills
  around the stop button as the user holds. This is **interaction motion, not ambient motion** — it
  tracks the finger and stops the moment the finger lifts, so it is exempt from the "ambient motion
  only while live" rule but not from the honesty rule: releasing early cancels and says so.
- **Arrival moments:** when a transcript or summary flips to Ready while the user is looking, the
  status badge pops to `success` and the content does a staggered rise-in. One celebration per
  arrival — no looping, no confetti storms; a single warm beat.

### Rules

- Ambient/looping motion is reserved for genuinely live things: the recording pulse (only while
  audio is actually being captured) and the active-stage shimmer (only while that stage runs).
  Everything else animates on transition only.
- Never animate during audio capture in ways that suggest capture stopped (no pausing the pulse for
  a celebration).
- Motion must never delay interaction: elements are interactive immediately; animation is cosmetic
  overlay.
- Celebrations are strictly visual — no sound, no haptics, on any platform. Quorum is used in and
  around live meetings; the app never makes noise.
- **`prefers-reduced-motion`:** all of it goes. Looping animations stop, transitions collapse to
  none or a ≤ 120ms fade, the pulse becomes a static solid dot + "REC" label, celebrations become an
  instant badge change. Hold-to-stop keeps working — the ring simply stops animating and the hint
  text carries the interaction. State is always carried by icon + text.

## 6. Iconography & illustration

[Lucide](https://lucide.dev) (ISC license, ships with shadcn/ui). 20px default in dense UI, 24px in
nav/controls. Stroke width 2 (1.75 at small sizes). Key mappings: `Mic` record, `Square` stop,
`Pause`/`Play`, `FileText` transcript, `ScrollText` summary, `CloudOff` offline, `Loader2`
processing (spin), `Trash2` delete, `Settings`, `ListChecks` templates, `Sparkles` arrival moments.

**Empty-state visuals** (empty states, onboarding): no illustrations, no abstract shapes, no
characters. The visual is a single large Lucide icon in a soft rounded container — a
`--radius-card-lg` tile filled with `honey-subtle`, icon stroked in `honey-strong`. Warmth comes
from color, radius, typography, and the motion language (staggered rise-in) — not from figures.
Everything themes via tokens for dark mode.

**Mascot: evaluated and rejected.** A mascot character (blob figure with a face) was prototyped for
the empty states and rejected by the PO — it does not meet the quality bar and is out of scope, not
deferred. Do not reintroduce characters or organic blob artwork; the icon-tile pattern above is the
standard for empty-state visuals.

## 7. Accessibility baseline

- **Measured contrast.** Core pairs pass WCAG 2.1 AA comfortably: foreground on background 15.3:1
  (light) / 15.2:1 (dark), muted-foreground on background 4.8:1 / 6.8:1, primary-foreground on
  primary 13.4:1 / 9.7:1. Every dark-mode pair passes AA for body text.
- **Two light-mode tint pairings currently fall short of AA for small text** and are carried from
  the reference as-is rather than silently altered:
  `honey-strong` on `honey-subtle` is **3.86:1** and `warning` on `warning-subtle` is **3.97:1**.
  Both clear the 3:1 bar for large text and UI glyphs, but badges render at `text-xs`, which is not
  large text. Until this is resolved, do not rely on those two pairings alone to carry meaning —
  the badge icon and label must do it (which the state rules already require). Resolving it needs a
  PO call: darken the text step or lighten the tint.
- `honey` is a fill color and must never be used as text on paper — use `honey-strong`.
- Every state (recording, offline, processing, failed) is conveyed by icon + text + color — never
  color or motion alone.
- Focus visible everywhere (`ring` token, 2px offset).
- Recording state changes are announced via `aria-live="assertive"`; job status changes via
  `aria-live="polite"`.
- Hold-to-stop must have a keyboard-operable equivalent; the hint text names the interaction.
- Full keyboard operability; dialogs trap focus (Radix defaults via shadcn).
- All playful motion honors `prefers-reduced-motion` (see §5).
