# Quorum Component Inventory (V1)

All components build on shadcn/ui primitives (Radix under the hood) themed via `tokens.css`. This file lists purpose, states, motion, and the shadcn base for each. Naming below = suggested component names in `src/components/`. Motion references: DESIGN-SYSTEM.md §5 (durations, easings, micro-interaction catalog).

**Icon standard: [Lucide](https://lucide.dev) (ISC license)** — the only icon set in the product; never hand-drawn glyphs or mixed sets. In React use `lucide-react` (tree-shaken, bundled — zero external requests); in static assets/mockups inline the actual Lucide SVG paths. Concrete assignments: `Mic` (record), `Square` (stop), `Pause`/`Play` (playback + session pause), `SkipBack`/`SkipForward` (±15s), `LayoutList` (meetings nav), `ListChecks` (templates nav), `Settings` (settings nav), `FileText` (transcript), `ScrollText` (summary), `Search` (list search), `X` (clear/close), `RefreshCw` (regenerate), `UploadCloud` (uploading), `Clock` (queued), `LoaderCircle` (running jobs, spinning), `Check` (ready/confirm), `AlertTriangle` (failed), `CloudOff` (offline), `Ban` (canceled), `Trash2` (delete), `MoreVertical` (overflow menu), `ShieldCheck` (consent), `Sparkles` (arrival moments).

Install baseline shadcn primitives: `button, card, dialog, alert-dialog, sheet, input, textarea, label, select, badge, skeleton, separator, dropdown-menu, progress, slider, sonner (toast), form, switch, tabs, tooltip, scroll-area`.

## 1. Buttons — `Button` (shadcn `button`, as-is)

Variants (shadcn defaults, no changes needed): `default` (primary teal), `secondary`, `outline`, `ghost`, `destructive`, `link`. Sizes `sm | default | lg | icon`.

Rules:
- One `default` button per view region; everything else `secondary`/`ghost`/`outline`.
- Destructive variant only for actions that destroy data; always behind `ConfirmDialog`.
- States: default, hover (soft `shadow-md` lift on primary), active (press: scale 0.97 with `--ease-spring` return), focus-visible (ring), disabled (50% opacity, no pointer), loading (spinner replaces icon, label stays, `aria-busy`). Buttons never shrink while loading.
- Touch targets ≥ 44px on mobile (`size="lg"` or min-h utility).

## 2. RecordButton (custom, styled `button` element)

The single most important control — and the app's most characterful one. A circular button, 72px (mobile) / 64px (desktop).

- **Idle:** `bg-recording` circle with white `Mic` icon; label "Record" below. On hover/focus it lifts slightly (`shadow-md`) — it wants to be pressed.
- **Requesting mic / connecting:** disabled, spinner, label "Starting…".
- **Recording:** the circle morphs into a rounded square (`Square` stop glyph) over 320ms with `--ease-spring` — the "it's real now" moment. Timer above it in `font-mono text-timer`, breathing `RecordingIndicator` adjacent.
- **Paused:** static (no pulse), `Play` glyph to resume, timer frozen, "Paused" label.
- Not a shadcn variant — bespoke, but uses `Button` a11y patterns (focus ring, `aria-pressed`, `aria-label` describing next action).

## 3. RecordingIndicator (custom, distinctive)

Quorum's signature element — the honest "you are on the record" signal, with personality: **the breathing dot**. The app visibly listens.

- **Anatomy:** solid dot (10px, `bg-recording`) + `REC` in `font-mono text-xs font-medium tracking-widest` + elapsed time (mono, tabular).
- **Active:** dot breathes (`animate-recording-pulse`, 1.6s heartbeat). Where live input level is available (recording screen), the dot's scale is subtly modulated by the mic level (±10%, throttled ~10Hz) — personality and honesty in one element: if it moves with your voice, it is really capturing. Pulse runs ONLY while chunks are actually being captured.
- **Paused:** dot hollow (2px `border-recording` ring), no pulse, label `PAUSED` in `muted-foreground`.
- **Buffering offline:** dot keeps breathing (capture continues!) but a `CloudOff` glyph + buffered-duration counter appears beside it in `warning` (see STATES.md).
- **Reduced motion:** static dot, no pulse — state carried by glyph + label.
- Placement: pinned in the recording screen header; also rendered as a persistent slim bar (`RecordingBar`) at the top of every other screen while a session is live, tapping it returns to the recording screen.
- `role="status"`, `aria-live="assertive"` on state transitions ("Recording started", "Recording paused").

## 4. Cards — `Card` (shadcn `card`, as-is)

`Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter`. Soft radius (`--radius`), `shadow-sm` at rest; link-target cards lift to `shadow-md` and translate up 1px on hover. Used for: meeting list items (mobile), summary sections, settings groups, template sections.

## 5. Lists — `MeetingList` / `MeetingListItem` (composition: `Card` + `Badge` + `DropdownMenu`)

- **Row anatomy:** title (or "Untitled meeting" fallback), date + duration in `text-sm text-muted-foreground font-mono` (duration), `StatusBadge`, overflow menu (`DropdownMenu`: Open, Rename, Delete).
- **Motion:** rows enter with `animate-rise-in` staggered 30ms (cap 10); a row whose status changes gets the badge flip (pop-out/pop-in); confirmed-deleted rows collapse their height smoothly.
- **States:** default, hover/pressed (`bg-accent` + slight lift), focused (ring), processing (badge animates), failed (badge + row retains full functionality — audio is still playable), deleting (row dimmed 50%, spinner, non-interactive).
- **Search (V1):** pill-shaped `Input` (shadcn `input`, `rounded-full`) with a leading `Search` icon and a trailing `X` clear button when non-empty, placed in the list header. Client-side live title filter; matching is case-insensitive substring. Empty result: calm note "No meetings match “…”" + "Clear search" ghost button — no illustration (search-empty is not a playful moment, the user is looking for something).
- **Empty state:** see `EmptyState` (§12) — the meetings list is the flagship playful empty state (shown only when the list itself is empty, never for empty search results).
- **Loading:** 3–5 `Skeleton` rows matching row geometry.
- Virtualize when list > ~50 entries (later; not a V1 blocker).

## 6. StatusBadge (shadcn `badge`, extended variants)

Maps meeting/job state → visual. Always icon + label, never color or motion alone. `bg-{status}-subtle text-{status}` pattern, `text-xs`, pill radius. State changes animate with the badge flip (`animate-pop-in` on the incoming badge).

| Status | Token | Icon | Label |
|---|---|---|---|
| Recording (live) | `recording` | breathing dot | Recording |
| Uploading / finalizing | `info` | `UploadCloud` | Uploading |
| Queued | `info` | `Clock` | Queued |
| Transcribing | `info` | `Loader2` (spin) | Transcribing |
| Summarizing | `info` | `Loader2` (spin) | Summarizing |
| Ready | `success` | `Check` | Ready |
| Failed | `destructive` | `AlertTriangle` | Failed |
| Offline buffer | `warning` | `CloudOff` | Saved on device |
| Canceled | neutral (`muted`) | `Ban` | Canceled |

Derivation from data: meeting status = live session state, else latest `Job` per type (`shared/src/job.ts`): any `failed` → Failed; `summarize.succeeded` → Ready; `running`/`queued` → Transcribing/Summarizing/Queued.

## 7. Dialogs

- **`Dialog`** (shadcn `dialog`): forms and detail overlays on desktop. On mobile (< md), prefer **`Sheet`** (bottom sheet) for the same content. Sheets slide with `--ease-enter` over 320ms.
- **`ConfirmDialog`** (shadcn `alert-dialog`): all destructive confirmations. Title states the consequence ("Delete this meeting?"), body lists exactly what is destroyed (audio, transcripts, summaries — cascade per ADR-001), destructive action button right-aligned, `Cancel` is the initially-focused default. No playfulness here — serious moments are rendered straight.
- **`ConsentNotice`**: specialized `AlertDialog` before recording starts — see STATES.md §1. Not dismissible by outside-click or Escape; explicit choice required.

## 8. Forms (shadcn `form` + `input`, `textarea`, `label`, `select`, `switch`)

Used in: meeting rename, template editor, settings.

- Labels always visible above the field (no placeholder-as-label). Help text `text-sm text-muted-foreground` below — help text may be warm and encouraging ("Give this template a name you'll recognize later.").
- Validation on blur + on submit; error text in `text-destructive text-sm` with `AlertCircle` icon, field border → `border-destructive`, `aria-invalid`. Error messages are kind but unambiguous.
- States per field: default, focus (ring, 140ms ease), filled, error, disabled.
- Selects: shadcn `select`; on mobile it renders in a popover — acceptable for V1.
- Template section editor rows: `Card` per section with plum section marker (`bg-plum-subtle` accent strip), `Input` (title), `Textarea` (instruction), `Select` (format: prose/bullets/table), reorder via up/down buttons in V1, hide/remove per override semantics (`shared/src/summary.ts`). Adding a section pops the new card in (`animate-pop-in`).

## 9. AudioPlayer (custom; composed from shadcn `slider` + `Button` + `DropdownMenu`)

Playback of finished recordings, synced with the transcript. Round, friendly controls — pill-shaped bar, circular buttons.

- **Anatomy:** play/pause (circular icon button, 44px, springs on press), seek slider (shadcn `slider` restyled: 4px track, `primary` fill, thumb grows on touch), current time / total duration in `font-mono text-sm tabular-nums`, playback-rate menu (0.75× 1× 1.25× 1.5× 2×), skip ±15s buttons (desktop and ≥ sm).
- **Placement:** sticky bottom bar within meeting detail so it stays visible while scrolling the transcript.
- **States:** loading (skeleton bar, controls disabled), ready, playing, paused, seeking (thumb enlarges, time tooltip), error (bar shows "Audio unavailable" + retry, `destructive` text), audio deleted (bar replaced by muted note).
- **Transcript sync contract:** exposes `currentTime` (throttled ~4Hz) and `seekTo(seconds)`. Transcript view highlights the active segment/word from `currentTime`; clicking a word calls `seekTo(word.start)` (word timestamps from `shared/src/transcript.ts`).
- Keyboard: Space play/pause, ←/→ ±5s, ↑/↓ rate (when player focused). Media Session API for lockscreen controls (PWA).

## 10. TranscriptView (custom)

- Segment blocks: speaker label (when present) `text-sm font-semibold`, text `text-base leading-relaxed max-w-[65ch]`, timestamp `font-mono text-xs text-muted-foreground` in the gutter (tap segment to reveal on mobile).
- Active segment during playback: `bg-accent` block highlight (the highlight glides between segments, 220ms); active word: underline/darker weight — never color alone.
- **Arrival moment:** when the transcript first flips to Ready in view, the first ~8 segments rise in staggered (`animate-rise-in`), then everything is static. One warm beat, then business. Strictly visual — celebrations never play sound (PO decision; also: the user may still be in a meeting).
- Displays `editedText ?? text` (overlay model, ADR-003); V1 is read-only, edits are V2.
- Low-confidence segments (`confidence < 0.5`): dotted underline + tooltip "Low transcription confidence".
- Transcript content itself is sacred data: no decorative color, no playful styling inside the text.

## 11. SummaryView (custom, `Card` per section)

The summary is the "thinking" side of the product — it carries the plum identity: section title row gets a small plum marker, the tab's ready-dot pops in plum/honey.

- Renders `Summary.sections` in template order: section title `text-lg font-semibold`, content per `format` (prose paragraphs / `ul` bullets / simple table in `overflow-x-auto`). Sections rise in staggered on arrival.
- Footer meta: template name + version snapshot, model, generated-at, in `text-xs text-muted-foreground`.
- Copy-to-clipboard button per section and for the whole summary (Markdown); copy confirms with a springy `Check` swap on the button itself.
- **Regenerate (V1):** `outline` button with `RefreshCw` icon in the summary header. Creates a new summarize job with the currently selected template (cheap by design — ADR-003/004 reprocessing); the tab flips back to the processing state with the stepper at "Summarizing". The previous summary remains visible (dimmed, labeled "Previous version") until the new one arrives — no data vanishes optimistically. No confirm dialog: regenerating destroys nothing.

## 12. EmptyState (custom) — where playfulness lives

Anatomy: spot illustration (inline SVG per DESIGN-SYSTEM.md §6, rises in once on mount), `text-3xl`-capable headline, one warm sentence, optional primary action. Never a bare "No data".

- **Meetings list (first run):** mic-centered illustration in honey/teal; "Your first meeting awaits" / "Record it here — transcript and summary follow on their own." / [Start recording]. This doubles as onboarding: a secondary ghost link "How Quorum works" opens a 3-step explainer sheet (record → transcribe on your infrastructure → summarize your way), each step with its own small illustration.
- **No transcript yet / no summary yet:** quiet processing panel (see STATES.md §4) — alive, not empty.
- **No user templates:** plum illustration; "Summaries, your way" / "Start from the system template and shape the sections you actually need." / [Create a template].
- **Deleted meeting URL:** calm, not playful — "This meeting was deleted." with a link back.

## 13. Feedback primitives

- **Toast** (`sonner`): transient confirmations ("Meeting deleted", "Template saved") and non-blocking errors with a Retry action. Toasts slide-and-spring in. Never used for recording-critical state — that lives in persistent UI.
- **`Progress`** (shadcn): determinate job progress when `job.progress != null` (fills with `--ease-enter`); otherwise indeterminate badge/spinner or stage shimmer.
- **`Skeleton`**: all loading lists/details; skeletons mirror real layout geometry; shimmer uses the shared keyframes.
- **`Banner`** (custom, slim full-width strip under the header): persistent app-level conditions — offline mode, reconnecting, "recording in progress" (as `RecordingBar`). Variants map to status tokens. Banners slide down/up (220ms) so appearing and disappearing is itself an honest, visible state change.
- **`PipelineStepper`** (custom): the friendly processing readout — see STATES.md §4. Stages as connected pill steps (done: `success` check with pop-in; active: `info` with shimmer; upcoming: muted outline).
