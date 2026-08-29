# Critical Product States

These moments are Quorum's trust surface. Each section defines what the user sees, the exact behavior, and the copy direction (en-US source strings; all via i18n). Data contracts referenced: `shared/src/recording-protocol.ts` (chunk streaming, `persistedSeq`), `shared/src/job.ts` (async jobs), ADR-001 (cascade delete), ADR-002 (crash-safe streaming).

Tone rule for this file: the product is warm everywhere, but **serious moments are rendered straight** — consent, deletion, and failures get calm, factual treatment; waiting, arriving, and empty moments are where personality lives (DESIGN-SYSTEM.md §1).

## 1. Consent notice (before recording starts)

Recording other people is the user's legal responsibility (PITCH.md, legal stance). The product surfaces this clearly — the notice is part of the brand, not fine print. No playfulness here.

**Behavior**
- Shown as a `ConsentNotice` dialog (AlertDialog) when the user taps Record, **before** `getUserMedia` is requested. Not dismissible via outside-click or Escape.
- Two actions: primary "I have informed the participants" (proceeds → mic permission → session start) and ghost "Cancel".
- A "Don't show again" switch is **deliberately not offered in V1** — the reminder appears on every recording start. (Open for PO: frequency capping later.)
- Screen readers: dialog role `alertdialog`, title announced.

**Visual**: calm, not alarming — `info` icon (`ShieldCheck`), regular card surface, no red, no illustration.

**Copy direction**
> **Before you record**
> You are responsible for informing all participants that this meeting is being recorded, and for obtaining any consent required where you are. Quorum cannot notify participants outside this app.
> [Cancel] [I have informed the participants]

## 2. Recording (active)

**Visual**
- Dedicated recording screen: large mono timer (`text-timer`, tabular), the breathing `RecordingIndicator` (COMPONENTS.md §3 — pulse modulated by live mic level: the app visibly listens), RecordButton in stop form, Pause button, meeting title field (editable inline, optional).
- Live input-level meter (thin rounded bar under the timer) reinforces trust that the mic is picking up audio. If input is silent for > 10s while recording: inline hint "No audio detected — check your microphone" (`warning`).
- Sync status line under the timer, driven by `chunk.ack`/`persistedSeq` — and silent whenever there is nothing to say (§9):
  - All acked: **nothing at all**. The breathing indicator and the running timer already confirm the recording is alive; a standing `Synced` would be text the user can act on in no way.
  - Chunks still waiting: `Saving your recording… (12s still on this device)`, after a short delay and with a minimum time on screen, so the ordinary sub-second round trip never flashes up.
- Screen wake lock active; leaving the screen keeps the session and shows the persistent `RecordingBar` on other screens.

**Behavior**
- Pause: indicator hollow, breathing stops, timer freezes (`session.pause`). Resume reverses (dot pops back in with spring).
- Stop: single tap → small confirm popover ("Stop recording?") to prevent pocket-stops on mobile → `session.end` → transitions to Finalizing (§4 Uploading).
- Browser/tab crash: on next app open, an unfinished session with local buffer triggers a recovery card in the meeting list: "A recording was interrupted — 14 min are safe on this device." → actions: "Upload and finish" / "Discard". Reassuring, factual.

## 3. Offline / reconnecting (the chunk buffer)

Capture never stops because the network does — this is ADR-002's promise made visible. The tone is a calm "we've got this", never alarm.

**States & visuals**
1. **Degraded (acks lagging):** sync status line switches to `warning`: `Connection unstable — 8s buffered on this device`. The indicator keeps breathing.
2. **Offline (socket lost):** persistent `Banner` (warning variant, `CloudOff`, slides down): `Offline — recording continues, your audio is safe on this device`. Buffered duration counts up live (derived from unacked chunks in IndexedDB). Timer and breathing continue unchanged — the user must see capture is unaffected.
3. **Reconnecting:** banner: `Reconnecting…` with subtle spinner. On reconnect, client resumes from `persistedSeq`; banner briefly flips to success with a small pop: `Back online — uploading buffered audio (14s)…` with determinate progress as the buffer drains, then slides away.
4. **Storage pressure:** if IndexedDB quota nears its limit during a long offline stretch: banner escalates to `destructive`: `Device storage almost full — recording may stop in ~N min. Reconnect to upload.` (best-effort estimate). Straight tone, no softening.

**Rules**
- Never show a generic "error" while offline capture works — offline is a *warning*, not a failure.
- Never silently drop audio. If a chunk cannot be persisted locally, stop the recording with an explicit error dialog rather than pretending.
- Stopping while offline is allowed: meeting appears in the list with `Saved on device` badge (warning); upload + finalization resume automatically on reconnect.

## 4. Processing (async jobs) — waiting that feels alive

After `session.end`, the user waits for transcript and summary. Job model: `shared/src/job.ts` (`queued | running | succeeded | failed | canceled`, optional `progress` 0..1). Waiting is a personality moment — the pipeline should feel like the app is genuinely at work for you, while every stage stays literal and true.

**The `PipelineStepper`** (meeting detail; list shows the condensed badge): stages as connected pill steps —
1. **Uploading** — buffered chunks draining, waiting for `session.finalized` (determinate when buffer size is known).
2. **Queued** — job exists, not started (`Clock`).
3. **Transcribing** — `transcribe` running.
4. **Summarizing** — `summarize` running.
5. **Ready** — summary succeeded.

Done steps: `success` check that pops in. Active step: `info` pill with a gentle shimmer (the only looping motion besides the recording pulse). Upcoming: muted outline. Determinate `Progress` bar inside the active pill when `progress != null`. No fake progress, ever — indeterminate shimmer unless the backend reports numbers.

**Copy direction (warm, honest):**
- Transcript panel while working: "Transcribing your meeting — usually a few minutes. Feel free to leave; we'll keep at it." + skeleton lines.
- Summary panel: "Your summary is next — it starts as soon as the transcript is done."

**Behavior**
- Waiting is non-blocking: user can leave, list badge reflects state (poll/SSE). No screen ever forces the user to watch a spinner.
- Audio player is available as soon as audio is finalized, independent of transcript state.
- Partial readiness is normal: transcript `Ready` while summary still running — tabs carry independent state.
- **Arrival moment:** when a stage the user is looking at completes, play the celebration beat (DESIGN-SYSTEM.md §5): tab dot pops (honey), content rises in staggered, badge springs to `success`, and a one-line toast if the user is elsewhere in the app: "Transcript's ready." Celebrations are strictly visual on every platform — no sound, no haptics (PO decision; the user may still be sitting in a meeting).

## 5. Failed

`job.status === "failed"` with `{code, message}`. Failures are rendered straight — kind, but zero ambiguity and zero cuteness.

**Visual**
- Badge `Failed` (`destructive`, `AlertTriangle`); the stepper shows the failed stage in `destructive` with the later stages muted.
- In meeting detail, the affected tab shows an error panel (not a toast): title "Transcription failed" / "Summary failed", the human-readable `error.message`, the `error.code` in `font-mono text-xs text-muted-foreground` (support reference), and a primary **Retry** button (creates a new job — cheap by design, ADR-003 reprocessing).
- Crucially: everything that succeeded stays usable. Failed summary ≠ broken meeting — audio playback and transcript remain fully functional. A failed transcription still leaves audio playable.

**Behavior**
- Retry re-queues → state returns to §4 (the stepper visibly resets the failed stage to Queued).
- No auto-retry loops in the UI; the user stays in control (backend may retry internally).

## 6. Deleting / deleted

Real deletion is a core promise (ADR-001 cascade). The UI treats it with matching gravity and honesty — this is a no-playfulness zone.

**Confirm** (`ConfirmDialog`, alert-dialog):
> **Delete this meeting?**
> "Weekly sync — Aug 29" and everything derived from it will be permanently deleted: the audio recording, all transcripts, and all summaries. This cannot be undone.
> [Cancel] [Delete permanently]

Cancel is the default-focused action; the destructive button uses `destructive` variant.

**During deletion**
- List row dims to 50%, spinner replaces the badge, label `Deleting…`, row non-interactive. Deletion is a server-side cascade and may take a moment — no optimistic vanish; the row collapses only when the server confirms.

**After deletion**
- Toast (no undo — deletion is real): `Meeting deleted — audio, transcripts, and summaries removed.`
- Navigating to a deleted meeting's URL: quiet empty state "This meeting was deleted." with a link back to the list (calm variant — no illustration, no playful copy).
- Deliberately **no** trash/restore in V1: true deletion is the promise. If the PO wants a grace period later, it must be an explicit, visible retention setting — never a hidden soft delete.

## 7. Empty states & onboarding

Defined per component in COMPONENTS.md §12 — the designated home of playfulness: first-run meetings list (doubles as a 3-step "How Quorum works" onboarding sheet), no-templates state, and the arrival celebrations. Rule of placement: playful moments appear where nothing is at stake; the closer a moment sits to consent, capture integrity, failure, or deletion, the straighter it is rendered.

## 8. Cross-cutting rules

- Every state above is expressed as icon + label + color (tokens: `recording`, `warning`, `info`, `success`, `destructive`) — never color or motion alone.
- State transitions announced via `aria-live` (assertive for recording, polite for jobs).
- Persistent conditions live in persistent UI (banners, badges, stepper); toasts only for transient confirmations.
- All celebrations and micro-interactions honor `prefers-reduced-motion` (DESIGN-SYSTEM.md §5).
- All copy above is direction, not final — final strings live in the i18n catalog.

## 9. The resting state is silent

A status surface says nothing while everything is fine. "Working as intended" is not news, and a standing reassurance — `Synced`, `Connected`, `All good` — is text the reader can do nothing with; it costs attention every time the eye passes it, and it dulls the states that do matter.

Every visible status string must survive one question: **what does the reader now know, and what could they do with it?** If the answer is "nothing", or "nothing they weren't already doing", the surface stays empty. Status text is for conditions that inform a decision: work still outstanding (with the real figure attached), a degraded or lost connection, a failure, a choice to be made.

Absence of a message is not absence of feedback. Liveness is carried by the elements that are alive anyway — the breathing indicator, a running timer, a filling level meter. They already prove the system is working, and they do it without words. This is the same honesty rule as the rest of this file; it just recognizes that for the healthy case, saying nothing is the accurate report.

Two consequences worth stating outright:

- A message that does appear must be readable. Transient conditions get a short delay before they appear at all and a minimum time on screen once they have, so a state that resolves in a heartbeat never flashes up unread (the recording sync line, §2 and §3).
- The screen-reader live region stays mounted even while it is empty, so the message that does arrive is announced rather than lost together with the element that carried it.
