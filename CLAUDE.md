# Quorum — Arbeitsprozess (Team-Regeln)

Prozess übernommen aus Grimoire, bestätigt vom PO am 2026-08-29.

## Git & PR-Prozess

- **main ist geschützt — per Prozess, nicht per Branch Protection** (Free-Plan, privates Repo). NIE direkt auf main pushen, keine Ausnahmen.
- Jedes Ticket läuft in einem eigenen Worktree auf einem Feature-Branch: `<issue-nr>-<slug>` (z. B. `4-websocket-recording-endpoint`).
- Merge NUR wenn: **CI grün** (Typecheck, Tests, Build, E2E) **+ Lead-Verifikation** (Click-Path bei UI-Änderungen) **+ explizites PO-Approval am PR**.
- Commits mit der konfigurierten Identität `joCur <mail@jonascurth.de>` — nie per `-c` übersteuern.
- Worktrees: alle `.env*`-Dateien aus dem Repo-Root in den Worktree symlinken (gitignored, sonst schwer diagnostizierbare Fehler).

## Team & Rollen

- Der **Lead implementiert nicht selbst** — auch keine Einzeiler. Er scoped Tickets, briefed Engineers, reviewt, verifiziert und merged.
- Engineer-Agents (Backend, Frontend, Infra, QA) laufen auf **Opus**; nur der Lead auf Fable. Designer auf Fable nur auf expliziten PO-Wunsch.
- Rollen: Backend/Pipeline · Frontend/PWA · Infra/Ops · QA/Security.

## Tickets

- Roadmap lebt als GitHub-Issues + Milestones (`V1 — Walking Skeleton`, `V2 — Ausbau`, `Später / Compliance`).
- Jedes Issue: Kontext (welche ADRs gelten), Akzeptanzkriterien, betroffene Schemas aus `shared/src/`.
- Architektur-Entscheidungen werden als ADR in `adr/` festgehalten, bevor implementiert wird.

## Kritische Pfade (E2E-Pflicht)

Jede Änderung, die einen dieser Pfade berührt, braucht einen (ggf. erweiterten) E2E-Test:

1. Aufnahme → Chunk-Streaming → Persistierung → Transcript → Summary (der Kernpfad)
2. Auth-Flows (Login, Token-Refresh, Mandanten-Scope)
3. Vollständiges Löschen eines Meetings (Kaskade: Audio, Transcripts, Summaries, Jobs)
4. Crash-Recovery: Reconnect ab `persistedSeq`, IndexedDB-Puffer

## Architektur-Grundregeln

- `shared/src/` (Zod-Schemas) ist Single Source of Truth — Client und Server importieren, nie duplizieren.
- Maschinen-Output ist immutabel; Nutzerkorrekturen sind Overlays (ADR-003/004).
- Jede lang laufende Operation ist ein serverseitiger Job (Job-Schema in `shared/src/job.ts`) — nie browser-gebunden.
- Mandanten-/User-Scope in jedem Datenobjekt ab Tag 1 (ADR-001).
