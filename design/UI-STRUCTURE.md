# V1 UI Structure — Screens & Navigation

Mobile-first PWA (phones are a primary case); every screen scales up to desktop. Layout: single-column on mobile with a bottom tab bar; on ≥ md, a slim left sidebar replaces the tabs and content gets a centered max-width (~720px for reading views, wider for the list).

## 1. Navigation model

Three top-level destinations + one modal flow:

- **Meetings** (default/home) — list of all meetings with status.
- **Templates** — summary template list + editor.
- **Settings** — account, appearance, app info.
- **Record** — not a tab in the usual sense: a prominent center action (FAB-style raised record button in the mobile tab bar; primary button in the desktop sidebar) that launches the recording flow.

While a recording session is live, a persistent `RecordingBar` (slim strip: pulsing indicator + timer + "Return to recording") sits above the content on every other screen.

Auth (OIDC redirect) wraps everything; unauthenticated users only see the sign-in screen.

## 2. Screen inventory

### 2.1 Meetings list (`/meetings`)
- Header: "Meetings" + search field (pill-shaped `Input` with `Search` icon; client-side title filter in V1, live as you type, clear button when non-empty; "no results" shows a calm empty note with a "Clear search" action — no illustration).
- List of `MeetingListItem`s, newest first: title, date, duration, `StatusBadge`, overflow menu (Open / Rename / Delete).
- Recovery card at top if an interrupted local session exists (STATES.md §2).
- Empty state (first run): honey icon tile (`Mic`, per COMPONENTS.md §12) + "Your first meeting awaits" + primary "Start recording" + ghost link "How Quorum works" opening the 3-step onboarding sheet (COMPONENTS.md §12). This is the app's front door — it should feel like an invitation, not a void.

### 2.2 Recording flow (`/record`)
1. Tap Record → **Consent notice** (STATES.md §1).
2. Confirm → mic permission (browser prompt; denial shows an inline explainer with retry, not an error toast).
3. **Recording screen**: timer, level meter, `RecordingIndicator`, sync status, pause/resume, stop (with confirm popover), optional title field. Wake lock held.
4. Stop → brief finalizing state → navigate to the new meeting's detail (processing states take over).

### 2.3 Meeting detail (`/meetings/:id`)
- Header: title (inline-editable), date, duration, `StatusBadge`, overflow (Rename / Delete).
- **Tabs: Transcript | Summary** (shadcn `tabs`), each with independent processing/failed/ready states.
  - Transcript tab: `TranscriptView` with word timestamps; playback-synced highlighting; tap word → seek.
  - Summary tab: `SummaryView` (sections per template snapshot) + **Regenerate** action (in V1: creates a new summarize job with the current template; button shows the `RefreshCw` icon, flips the tab back into the processing state — stepper at "Summarizing") + copy actions.
- **Sticky bottom `AudioPlayer`** (available as soon as audio is finalized, independent of transcript state).

### 2.4 Templates (`/templates`)
- List: system template (marked "System", read-only, "Duplicate" action) + user templates (`basedOn` system, per `shared/src/summary.ts`).
- **Template editor** (`/templates/:id`): name field; options (tone, length, output language as selects); section list — each section a card with title, instruction textarea, format select (prose/bullets/table), reorder (up/down), hide/remove; "Add section". Save = new template version (versioning surfaced quietly in meta text).
- Inherited sections show a subtle "From system template" tag; overriding converts them to an override entry (add/replace/hide semantics handled transparently).

### 2.5 Settings (`/settings`)
- Account: signed-in identity, sign out.
- Appearance: theme (system / light / dark).
- Language: UI language (i18n).
- About: version, self-hosted instance info.
- (Retention rules, quotas: V2 — leave a placeholder group out entirely rather than shipping disabled controls.)

### 2.6 Auth (`/login`)
- Minimal: wordmark, one-line value prop ("Your meetings. Your infrastructure."), "Sign in" button → OIDC redirect (Authorization Code + PKCE). Error banner on failed callback.

## 3. Flow diagram

```mermaid
flowchart TD
    Login[Sign in / OIDC] --> List

    subgraph Tabs [Bottom tabs / sidebar]
      List[Meetings list]
      Templates[Templates]
      Settings[Settings]
    end

    List -- "Record (center action)" --> Consent[Consent notice]
    Consent -- cancel --> List
    Consent -- confirm --> Mic[Mic permission] --> Rec[Recording screen]
    Rec -- "pause / resume" --> Rec
    Rec -- "stop + confirm" --> Finalize[Uploading / finalizing]
    Finalize --> Detail

    List -- open meeting --> Detail[Meeting detail]
    Detail --> T[Transcript tab]
    Detail --> S[Summary tab]
    Detail -- delete + confirm --> Deleted[Cascade delete] --> List

    Templates --> Editor[Template editor]

    Rec -. offline .-> Buffer[(IndexedDB chunk buffer)]
    Buffer -. reconnect, resume from persistedSeq .-> Finalize
```

## 4. Responsive rules

- `< md`: bottom tab bar (Meetings · Record · Templates · Settings — Record raised/circular in the center), full-width content, sheets instead of dialogs for forms.
- `≥ md`: left sidebar (wordmark, nav, record button), content max-width, dialogs.
- Recording screen is always full-screen and distraction-free on all sizes — the breathing indicator is the only ambient motion.
- PWA: installable, standalone display; theme-color follows `background` token per color scheme; recording screen prevents display sleep via Wake Lock API.

## 5. Route summary

| Route | Screen |
|---|---|
| `/login` | Auth |
| `/meetings` | Meeting list (home) |
| `/record` | Recording flow |
| `/meetings/:id` | Meeting detail (`?tab=transcript\|summary`) |
| `/templates` | Template list |
| `/templates/:id` | Template editor |
| `/settings` | Settings |
