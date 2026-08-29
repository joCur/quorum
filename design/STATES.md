# Critical Product States

These moments are Quorum's trust surface. Each section defines what the user sees, the exact behavior, and the copy direction (en-US source strings; all via i18n). Data contracts referenced: `shared/src/recording-protocol.ts` (chunk streaming, `persistedSeq`), `shared/src/job.ts` (async jobs), ADR-001 (cascade delete), ADR-002 (crash-safe streaming).

## 1. Consent notice (before recording starts)

Recording other people is the user's legal responsibility (PITCH.md, legal stance). The product surfaces this clearly — the notice is part of the brand, not fine print.

**Behavior**
- Shown as a `ConsentNotice` dialog (AlertDialog) when the user taps Record, **before** `getUserMedia` is requested. Not dismissible via outside-click or Escape.
- Two actions: primary "I have informed the participants" (proceeds → mic permission → session start) and ghost "Cancel".
- A "Don't show again" switch is **deliberately not offered in V1** — the reminder appears on every recording start. (Open for PO: frequency capping later.)
- Screen readers: dialog role `alertdialog`, title announced.

**Visual**: calm, not alarming — `info` icon (`ShieldCheck`), regular card surface, no red.

**Copy direction**
> **Before you record**
> You are responsible for informing all participants that this meeting is being recorded, and for obtaining any consent required where you are. Quorum cannot notify participants outside this app.
> [Cancel] [I have informed the participants]

## 2. Recording (active)

**Visual**
- Dedicated recording screen: large mono timer (`text-timer`, tabular), `RecordingIndicator` (pulsing dot + REC), RecordButton in stop form, Pause button, meeting title field (editable inline, optional).
- Subtle live input-level meter (thin bar under the timer) so the user trusts the mic is actually picking up audio. If input level is silent for > 10s while recording: inline hint "No audio detected — check your microphone" (`warning`).
- Sync status line under the timer, always visible and honest, driven by `chunk.ack`/`persistedSeq`:
  - All acked: `Synced` with `Check` (muted, quiet).
  - Chunks in flight/buffered: `Saving to server… (12s buffered on device)`.
- Screen wake lock active; leaving the screen keeps the session and shows the persistent `RecordingBar` on other screens.

**Behavior**
- Pause: indicator hollow, pulse stops, timer freezes (`session.pause`). Resume reverses.
- Stop: single tap → small confirm popover ("Stop recording?") to prevent pocket-stops on mobile → `session.end` → transitions to Finalizing (§4 Uploading).
- Browser/tab crash: on next app open, an unfinished session with local buffer triggers a recovery card in the meeting list: "A recording was interrupted. 14 min saved." → actions: "Upload and finish" / "Discard".

## 3. Offline / reconnecting (the chunk buffer)

Capture never stops because the network does — this is ADR-002's promise made visible.

**States & visuals**
1. **Degraded (acks lagging):** sync status line switches to `warning`: `Connection unstable — 8s buffered on this device`. Recording indicator keeps pulsing.
2. **Offline (socket lost):** persistent `Banner` (warning variant, `CloudOff`): `Offline — recording continues, audio is saved on this device`. Buffered duration counts up live (derived from unacked chunks in IndexedDB). Timer and pulse continue unchanged — the user must see capture is unaffected.
3. **Reconnecting:** banner: `Reconnecting…` with subtle spinner. On reconnect, client resumes from `persistedSeq`; banner briefly flips to success: `Back online — uploading buffered audio (14s)…` with determinate progress as the buffer drains, then disappears.
4. **Storage pressure:** if IndexedDB quota nears its limit during a long offline stretch: banner escalates to `destructive`: `Device storage almost full — recording may stop in ~N min. Reconnect to upload.` (best-effort estimate).

**Rules**
- Never show a generic "error" while offline capture works — offline is a *warning*, not a failure.
- Never silently drop audio. If a chunk cannot be persisted locally, stop the recording with an explicit error dialog rather than pretending.
- Stopping while offline is allowed: meeting appears in the list with `Saved on device` badge (warning); upload + finalization resume automatically on reconnect.

## 4. Processing (async jobs)

After `session.end`, the user waits for transcript and summary. Job model: `shared/src/job.ts` (`queued | running | succeeded | failed | canceled`, optional `progress` 0..1).

**Pipeline surfaced as stages** (meeting detail + list badge):
1. **Uploading / Finalizing** — buffered chunks draining, waiting for `session.finalized` (`info`, determinate if buffer size known).
2. **Queued** — job exists, not started. Badge `Queued`, `Clock` icon.
3. **Transcribing** — `transcribe` running. Spinner badge; determinate `Progress` bar in detail view when `progress != null`.
4. **Summarizing** — `summarize` running.
5. **Ready** — summary succeeded (`success`).

**Behavior**
- Waiting is non-blocking: user can leave, list badge reflects state (poll/SSE). No screen ever forces the user to watch a spinner.
- Meeting detail during processing: audio player is available as soon as audio is finalized; transcript area shows a quiet processing panel ("Transcribing — usually takes a few minutes. You can leave this page.") with skeleton lines. Summary tab mirrors this.
- Partial readiness is normal: transcript `Ready` while summary still running — tabs carry independent state.
- No fake progress: indeterminate spinner unless the backend reports `progress`.

## 5. Failed

`job.status === "failed"` with `{code, message}`.

**Visual**
- Badge `Failed` (`destructive`, `AlertTriangle`).
- In meeting detail, the affected tab shows an error panel (not a toast): title "Transcription failed" / "Summary failed", the human-readable `error.message`, the `error.code` in `font-mono text-xs text-muted-foreground` (support reference), and a primary **Retry** button (creates a new job — cheap by design, ADR-003 reprocessing).
- Crucially: everything that succeeded stays usable. Failed summary ≠ broken meeting — audio playback and transcript remain fully functional. A failed transcription still leaves audio playable.

**Behavior**
- Retry re-queues → state returns to §4.
- No auto-retry loops in the UI; the user stays in control (backend may retry internally).

## 6. Deleting / deleted

Real deletion is a core promise (ADR-001 cascade). The UI treats it with matching gravity — and matching honesty.

**Confirm** (`ConfirmDialog`, alert-dialog):
> **Delete this meeting?**
> "Weekly sync — Aug 29" and everything derived from it will be permanently deleted: the audio recording, all transcripts, and all summaries. This cannot be undone.
> [Cancel] [Delete permanently]

Cancel is the default-focused action; the destructive button uses `destructive` variant.

**During deletion**
- List row dims to 50%, spinner replaces the badge, label `Deleting…`, row non-interactive. Deletion is a server-side cascade and may take a moment — no optimistic vanish; the row disappears only when the server confirms.

**After deletion**
- Toast (no undo — deletion is real): `Meeting deleted — audio, transcripts, and summaries removed.`
- Navigating to a deleted meeting's URL: quiet 404-style empty state "This meeting was deleted." with a link back to the list.
- Deliberately **no** trash/restore in V1: true deletion is the promise. If the PO wants a grace period later, it must be an explicit, visible retention setting — never a hidden soft delete.

## 7. Cross-cutting rules

- Every state above is expressed as icon + label + color (tokens: `recording`, `warning`, `info`, `success`, `destructive`) — never color alone.
- State transitions announced via `aria-live` (assertive for recording, polite for jobs).
- Persistent conditions live in persistent UI (banners, badges); toasts only for transient confirmations.
- All copy above is direction, not final — final strings live in the i18n catalog.
