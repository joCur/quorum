# Quorum Component Inventory (V1)

All components build on shadcn/ui primitives (Radix under the hood) themed via `tokens.css`. This file lists purpose, states, and the shadcn base for each. Icons: Lucide. Naming below = suggested component names in `src/components/`.

Install baseline shadcn primitives: `button, card, dialog, alert-dialog, sheet, input, textarea, label, select, badge, skeleton, separator, dropdown-menu, progress, slider, sonner (toast), form, switch, tabs, tooltip, scroll-area`.

## 1. Buttons — `Button` (shadcn `button`, as-is)

Variants (shadcn defaults, no changes needed): `default` (primary teal), `secondary`, `outline`, `ghost`, `destructive`, `link`. Sizes `sm | default | lg | icon`.

Rules:
- One `default` button per view region; everything else `secondary`/`ghost`/`outline`.
- Destructive variant only for actions that destroy data; always behind `ConfirmDialog`.
- States: default, hover, active (pressed), focus-visible (ring), disabled (50% opacity, no pointer), loading (spinner replaces icon, label stays, `aria-busy`). Buttons never shrink while loading.
- Touch targets ≥ 44px on mobile (`size="lg"` or min-h utility).

## 2. RecordButton (custom, styled `button` element)

The single most important control. A circular button, 72px (mobile) / 64px (desktop).

- **Idle:** `bg-recording` circle with white `Mic` icon; label "Record" below.
- **Requesting mic / connecting:** disabled, spinner, label "Starting…".
- **Recording:** circle morphs to a rounded square (`Square` stop glyph), timer above it in `font-mono text-timer`, pulsing `RecordingIndicator` adjacent.
- **Paused:** static (no pulse), `Play` glyph to resume, timer frozen, "Paused" label.
- Not a shadcn variant — bespoke, but uses `Button` a11y patterns (focus ring, `aria-pressed`, `aria-label` describing next action).

## 3. RecordingIndicator (custom, distinctive)

Quorum's signature element — the honest "you are on the record" signal.

- **Anatomy:** solid dot (10px, `bg-recording`) + `REC` in `font-mono text-xs font-medium tracking-widest` + elapsed time (mono, tabular).
- **Active:** dot pulses (`animate-recording-pulse`, 2s). Pulse runs ONLY while chunks are actually being captured.
- **Paused:** dot hollow (2px `border-recording` ring), no pulse, label `PAUSED` in `muted-foreground`.
- **Buffering offline:** dot keeps pulsing (capture continues!) but a `CloudOff` glyph + buffered-duration counter appears beside it in `warning` (see STATES.md).
- **Reduced motion:** static dot, no pulse — state carried by glyph + label.
- Placement: pinned in the recording screen header; also rendered as a persistent slim bar (`RecordingBar`) at the top of every other screen while a session is live, tapping it returns to the recording screen.
- `role="status"`, `aria-live="assertive"` on state transitions ("Recording started", "Recording paused").

## 4. Cards — `Card` (shadcn `card`, as-is)

`Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter`. Flat with `border`; `shadow-sm` on hover only when the card is a link target. Used for: meeting list items (mobile), summary sections, settings groups, template sections.

## 5. Lists — `MeetingList` / `MeetingListItem` (composition: `Card` + `Badge` + `DropdownMenu`)

- **Row anatomy:** title (or "Untitled meeting" fallback), date + duration in `text-sm text-muted-foreground font-mono` (duration), `StatusBadge`, overflow menu (`DropdownMenu`: Open, Rename, Delete).
- **States:** default, hover/pressed (`bg-accent`), focused (ring), processing (badge animates), failed (badge + row retains full functionality — audio is still playable), deleting (row dimmed 50%, spinner, non-interactive).
- **Empty state:** centered `Mic` icon (muted), "No meetings yet", primary "Start recording" button.
- **Loading:** 3–5 `Skeleton` rows matching row geometry.
- Virtualize when list > ~50 entries (later; not a V1 blocker).

## 6. StatusBadge (shadcn `badge`, extended variants)

Maps meeting/job state → visual. Always icon + label, never color alone. `bg-{status}-subtle text-{status}` pattern, `text-xs`, radius-sm.

| Status | Token | Icon | Label |
|---|---|---|---|
| Recording (live) | `recording` | pulsing dot | Recording |
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

- **`Dialog`** (shadcn `dialog`): forms and detail overlays on desktop. On mobile (< md), prefer **`Sheet`** (bottom sheet) for the same content.
- **`ConfirmDialog`** (shadcn `alert-dialog`): all destructive confirmations. Title states the consequence ("Delete this meeting?"), body lists exactly what is destroyed (audio, transcripts, summaries — cascade per ADR-001), destructive action button right-aligned, `Cancel` is the initially-focused default. Deleting a meeting additionally requires the meeting title to be shown in the dialog (not typed — V1 keeps one tap + one confirm).
- **`ConsentNotice`**: specialized `AlertDialog` before recording starts — see STATES.md §1. Not dismissible by outside-click or Escape; explicit choice required.

## 8. Forms (shadcn `form` + `input`, `textarea`, `label`, `select`, `switch`)

Used in: meeting rename, template editor, settings.

- Labels always visible above the field (no placeholder-as-label). Help text `text-sm text-muted-foreground` below.
- Validation on blur + on submit; error text in `text-destructive text-sm` with `AlertCircle` icon, field border → `border-destructive`, `aria-invalid`.
- States per field: default, focus (ring), filled, error, disabled.
- Selects: shadcn `select`; on mobile it renders in a popover — acceptable for V1.
- Template section editor rows: `Card` per section with `Input` (title), `Textarea` (instruction), `Select` (format: prose/bullets/table), drag handle (V1: up/down buttons instead of drag), hide/remove per override semantics (`shared/src/summary.ts`).

## 9. AudioPlayer (custom; composed from shadcn `slider` + `Button` + `DropdownMenu`)

Playback of finished recordings, synced with the transcript.

- **Anatomy:** play/pause (icon button, 44px), seek slider (shadcn `slider` restyled: 4px track, `primary` fill), current time / total duration in `font-mono text-sm tabular-nums`, playback-rate menu (0.75× 1× 1.25× 1.5× 2×), skip ±15s buttons (desktop and ≥ sm).
- **Placement:** sticky bottom bar within meeting detail so it stays visible while scrolling the transcript.
- **States:** loading (skeleton bar, controls disabled), ready, playing, paused, seeking (thumb enlarges, time tooltip), error (bar shows "Audio unavailable" + retry, `destructive` text), audio deleted (bar replaced by muted note).
- **Transcript sync contract:** exposes `currentTime` (throttled ~4Hz) and `seekTo(seconds)`. Transcript view highlights the active segment/word from `currentTime`; clicking a word calls `seekTo(word.start)` (word timestamps from `shared/src/transcript.ts`).
- Keyboard: Space play/pause, ←/→ ±5s, ↑/↓ rate (when player focused). Media Session API for lockscreen controls (PWA).

## 10. TranscriptView (custom)

- Segment blocks: speaker label (when present) `text-sm font-medium`, text `text-base leading-relaxed max-w-[65ch]`, timestamp `font-mono text-xs text-muted-foreground` in the gutter (tap segment to reveal on mobile).
- Active segment during playback: `bg-accent` block highlight; active word: underline/darker weight — never color alone.
- Displays `editedText ?? text` (overlay model, ADR-003); V1 is read-only, edits are V2.
- Low-confidence segments (`confidence < 0.5`): dotted underline + tooltip "Low transcription confidence".

## 11. SummaryView (custom, `Card` per section)

Renders `Summary.sections` in template order: section title `text-lg font-medium`, content per `format` (prose paragraphs / `ul` bullets / simple table in `overflow-x-auto`). Footer meta: template name + version snapshot, model, generated-at, in `text-xs text-muted-foreground`. Copy-to-clipboard button per section and for the whole summary (Markdown).

## 12. Feedback primitives

- **Toast** (`sonner`): transient confirmations ("Meeting deleted", "Template saved") and non-blocking errors with a Retry action. Never used for recording-critical state — that lives in persistent UI.
- **`Progress`** (shadcn): determinate job progress when `job.progress != null`; otherwise indeterminate badge/spinner.
- **`Skeleton`**: all loading lists/details; skeletons mirror real layout geometry.
- **`Banner`** (custom, slim full-width strip under the header): persistent app-level conditions — offline mode, reconnecting, "recording in progress" (as `RecordingBar`). Variants map to status tokens.
- **`EmptyState`** (custom): icon (muted), one-line headline, optional body, optional primary action. Used for empty list, no transcript yet, no templates.
