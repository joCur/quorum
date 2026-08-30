# design-sync notes (Quorum)

Repo-specific gotchas for future syncs of the client design system to claude.ai/design.

## Setup

- The DS is the app package `@quorum/client` (no library dist) — the converter runs in
  synth-entry mode from `src/components` (cfg `srcDir`). All components are pinned via
  `componentSrcMap`; new components must be added there.
- The package must be self-resolvable: `client/node_modules/@quorum/client` is a symlink to
  `../..` (gitignored, recreate on fresh clones): `ln -sfn ../.. client/node_modules/@quorum/client`.
- Converter deps live in `.ds-sync/` (staged scripts) — recreate per the skill's step 7 on fresh
  clones, plus `ln -sfn ../.ds-sync/node_modules .design-sync/node_modules` for the lib fork.
- Build `@quorum/shared` first (`pnpm -F @quorum/shared build`) — a stale `shared/dist` fails the
  bundle with missing schema exports.

## CSS / fonts

- `cfg.cssEntry` points at the compiled Vite CSS `client/dist/assets/index-<hash>.css`. The hash
  changes on every `pnpm -F @quorum/client build` — after rebuilding the client, update
  `cssEntry` to the new filename before running the converter.
- The compiled CSS is Tailwind-purged to classes used in the app. Authored previews must use
  inline styles for layout glue — never invent utility classes.
- Brand fonts ship via `cfg.extraFonts` from fontsource packages (Plus Jakarta Sans Variable,
  JetBrains Mono 400/500).

## Known render warns

- `[FONT_MISSING] "Plus Jakarta Sans"` — deliberate: the token stack lists the static family as a
  fallback after "Plus Jakarta Sans Variable", which does ship. The static face is never installed
  by the app either. Not a defect.

## Exclusions / overrides

- `RecoveryCard` is excluded (`componentSrcMap: null`): it calls `useRecording()` (live recording
  context), returns `null` without a recoverable session, and its import chain pulls `@/env`
  (throws without `VITE_OIDC_*`) and the OIDC client. Not statically renderable.
- Lib fork `.design-sync/overrides/source-kit.mjs` (declared in `cfg.libOverrides`): honors
  `componentSrcMap` null-exclusions in the synth-entry file set — without it, excluded files
  (recovery-card → env chain) still enter the bundle and throw at load, emptying `window.Quorum`.
- `env.ts` validates `import.meta.env` at module load — nothing bundled may import it.

## Re-sync risks

- `cssEntry` hash goes stale on every client rebuild (see above) — the converter fails loudly
  ([CSS_IMPORT_MISSING]) or silently uses old CSS if the old file still exists; always re-check.
- The compiled CSS is purge-coupled to app usage: a component variant not yet used in the app
  renders unstyled in previews (this bit StatusBadge's `bg-recording-subtle` from a stale dist).
  Rebuild the client before syncing.
- The lib fork must be diffed against the bundled `lib/source-kit.mjs` on re-sync and merged.
- Preview harness (`.design-sync/preview-support.tsx`, via `extraEntries`) provides i18n init +
  MemoryRouter; its `extraEntries` path is relative to the node_modules package dir
  (`../../../../.design-sync/...`).

## Preview authoring learnings (wave 1, 2026-08-30)

- Inline `style={{}}` for all preview layout glue; never invent Tailwind classes (purged CSS).
- `Dialog` exports no `DialogHeader`/`DialogFooter` (compose with divs); `DialogContent` requires
  `closeLabel`. `AlertDialog` has Header/Footer. Dialog previews render open state with
  `modal={false}` where scroll-locking would hide the capture root.
- Fixture shapes from `shared/src`: `Meeting.audioFormat` is an object
  (`{codec, container, sampleRate, channels}`); `Segment` literals need the full overlay set
  spelled out (Zod defaults don't apply to literals).
- `AudioPlayer` renders statically with a silent WAV `data:` URI + `status="ready"` +
  `fallbackDuration`.
- Keep a preview cell under ~500 px; trim fixtures instead of exhaustive lists.
- Previews must not import `react-router-dom` directly — the preview entry bundles a second router
  instance whose context is invisible to the shared bundle (blank cell, ballooned _preview js).
  AppShell is therefore previewed as an empty frame. Possible future fix: re-export router pieces
  from `preview-support.tsx`.
- `LevelMeter` needs explicit `level`/`active` and a fixed-width wrapper (`w-full max-w-xs`).
- Capture harness patch (staged scripts, NOT persistent): `.ds-sync/package-capture.mjs` was
  changed from `page.clock.setFixedTime(...)` to `page.clock.install({time})` plus
  `page.clock.runFor(2500)` in `settle()` so time-gated UI (`useTransientStatus`,
  `appearAfterMs: 300`) opens deterministically — SyncStatus's SavingBacklog/ConnectionUnstable
  cells capture blank without it. Re-staging the scripts on a re-sync loses this patch;
  re-apply it before recapturing SyncStatus (or any `useTransientStatus` consumer).
- SyncStatus `Silent` cell is deliberately empty (quiet states say nothing — product framing);
  graded good by design.

## Known render warns (continued)

- Review sheets have viewport-tall cells; short components sit in whitespace — cosmetic only.
