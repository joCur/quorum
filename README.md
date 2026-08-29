# Quorum — Fundament (Schemas & ADRs)
> **Quorum** — Meetingaufzeichnung mit Transkription und konfigurierbaren Zusammenfassungen, self-hosted first.

Meetingaufzeichnung (live & online) mit konfigurierbaren Zusammenfassungen, geplant als SaaS. Webanwendung (Desktop + Mobile Browser, PWA), Wake Lock während der Aufnahme.

## Struktur

- `adr/` — Architecture Decision Records
  - ADR-001: Serverseitige Verarbeitung, Audio-Persistierung, Verschlüsselung at rest, Löschkonzept
  - ADR-002: Chunk-Streaming per WebSocket, Verarbeitung als asynchroner Job
  - ADR-003: Transcript-Datenmodell (Immutability, 1:n, Wort-Timestamps)
  - ADR-004: Summary-Templates (Vererbung, Snapshot, strukturierter Output)
  - ADR-005: Self-hosted Whisper + OpenAI-kompatible Summary-API
  - ADR-006: Stack decision (Fastify, React + Vite PWA, pg-boss, PostgreSQL, MinIO, whisperX, Keycloak)
- `PITCH.md` — Warum wir das bauen, V1-Demo-Definition, rechtliche Haltung
- `ROADMAP.md` — V1 → V2 → später (wird bei Projektstart zu GitHub-Issues)
- `OPEN-QUESTIONS.md` — Stack-Vorschläge, Observability, Missbrauchsschutz (bewusst offen)
- `COST-MODEL.md` — Kosten pro Meeting-Stunde (eigener Server vs. Cloud)
- `docker-compose.yml` + `docker-compose.gpu.yml` + `.env.example` — Self-Hosting-Skeleton, Hardware-Wechsel rein per Env
- `shared/src/` — Zod-Schemas als Single Source of Truth für Client & Server
  - `recording-protocol.ts` — WebSocket-Control-Messages + binäres Chunk-Format
  - `transcript.ts` — Transcript, Segmente, Sprecher, Wort-Timestamps
  - `summary.ts` — Templates, Overrides, erzeugte Summaries mit Snapshot
  - `job.ts` — Async-Job-API (Status, Fehlerformat, Ergebnis-Referenz)

## Development

pnpm workspaces monorepo, Node.js 22+. The pnpm version is pinned in the `packageManager`
field, so Corepack picks the right one automatically:

```bash
corepack enable   # once per machine
pnpm install
```

Root scripts (the same ones CI runs):

| Script               | What it does                                                  |
| -------------------- | ------------------------------------------------------------- |
| `pnpm run typecheck` | `tsc --build` over all packages (strict) plus the test sources |
| `pnpm test`          | Vitest unit and schema round-trip tests                        |
| `pnpm run build`     | Builds every workspace that has a `build` script               |
| `pnpm run lint`      | ESLint plus a Prettier formatting check                        |
| `pnpm run format`    | Rewrites files with Prettier                                   |
| `pnpm run e2e`       | Placeholder until the Playwright suite lands (issue #10)        |

Workspaces:

- `shared/` — package `@quorum/shared`, the zod schemas shared by client and server
- `server/` — package `@quorum/server`, the Fastify API: health endpoint, Keycloak JWT validation
  and the tenant-scoped request context. See `server/README.md` for the scoping convention and the
  manual auth verification path.

Infrastructure configuration:

- `infra/keycloak/` — the versioned `quorum` realm imported by the `keycloak` service on startup
  (ADR-006 §7), so `git clone && docker compose up` yields a working login with no admin-console
  clicking. Dev-only test users are documented in `infra/keycloak/README.md`.
- `infra/postgres/init/` — provisions Keycloak's own logical database on the shared Postgres
  instance (no second database container).

## Nächste Schritte (Walking Skeleton)

1. Auth aufsetzen (OIDC via fertige Lösung, Authorization Code + PKCE) — Mandanten-/User-Scope in jedem Datenobjekt ab Tag 1
2. Server: WebSocket-Endpoint gemäß `recording-protocol.ts`, Chunks in Object Storage persistieren, `chunk.ack` senden
3. Client: Aufnahme (getUserMedia + MediaRecorder), IndexedDB-Puffer für unbestätigte Chunks, Reconnect ab `persistedSeq`
4. Job-Worker: Audio → Whisper → `Transcript` gemäß Schema (inkl. `words[]`)
5. Summary-Worker: System-Template → LLM → `Summary` mit Template-Snapshot
6. E2E-Test des kritischen Pfads: Aufnahme → Streaming → Transcript → Summary

Shared Package: `@quorum/shared` (npm-Scope bei Repo-Setup prüfen). Abhängigkeit: `zod` (v3+).

## Lokale Entwicklung unter macOS

Docker-Container haben auf dem Mac **keinen GPU-Zugriff** (Linux-VM, kein Metal) — das CUDA-Image und `docker-compose.gpu.yml` sind dort gegenstandslos. Zwei Wege:

1. **Default — CPU-Image (volle Stack-Parität):** In `.env` das macOS-Profil setzen (`WHISPER_IMAGE_TAG=latest-cpu`, `WHISPER_DEVICE=cpu`, Modell `small`/int8). Identisches Compose-Setup wie Produktion — richtig für Integrations- und E2E-Tests.
2. **Speed-Modus — Whisper nativ mit Metal:** whisper.cpp (`--server`) oder mlx-whisper auf dem Host starten, Whisper-Container weglassen, im Worker `WHISPER_BASE_URL=http://host.docker.internal:8080/v1` setzen. Large-Qualität, schnell — für intensive Arbeit an der Transkriptions-Pipeline. Der Worker merkt dank OpenAI-kompatibler Abstraktion (ADR-005) keinen Unterschied.

Auf Apple Silicon auf arm64-Images achten (speaches, Postgres, MinIO liefern multi-arch), sonst bremst Rosetta-Emulation.
