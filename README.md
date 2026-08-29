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
| `pnpm run e2e`       | Placeholder until the Playwright suite lands                    |
| `pnpm run dev:client` | Starts the PWA dev server on http://localhost:5173            |

Workspaces:

- `shared/` — package `@quorum/shared`, the zod schemas shared by client and server
- `server/` — package `@quorum/server`, the Fastify API: Keycloak JWT validation with a
  tenant-scoped request context, plus the WebSocket recording endpoint. See `server/README.md`
  for the scoping convention and the manual auth verification path.
- `worker/` — package `@quorum/worker`, the job worker turning recorded audio into transcripts.
  See `worker/README.md` for the transcription backends, the idempotency rules and the retry
  and dead-letter behavior.
- `client/` — package `@quorum/client`, the React + Vite PWA

### Web client

The PWA reads its configuration from `VITE_*` variables; copy `client/.env.example` to
`client/.env.local` and point `VITE_OIDC_ISSUER_URL` at the Keycloak realm before running
`pnpm run dev:client`. Fonts and icons are bundled — the app makes no requests to any CDN at
runtime, which a self-hosted deployment depends on.

Infrastructure configuration:

- `infra/keycloak/` — the versioned `quorum` realm imported by the `keycloak` service on startup
  (ADR-006 §7), so `git clone && docker compose up` yields a working login with no admin-console
  clicking. Dev-only test users are documented in `infra/keycloak/README.md`.
- `infra/postgres/init/` — provisions Keycloak's own logical database on the shared Postgres
  instance (no second database container).

### Running the stack with Docker Compose

```bash
cp .env.example .env      # then replace every CHANGE_ME, see the comments in that file
docker compose up -d      # postgres, keycloak, minio (+ bucket bootstrap), whisper, api
curl http://localhost:8080/healthz
```

The `api` service is built from `server/Dockerfile`. Its build context is the repository root,
because the server consumes the `@quorum/shared` workspace and the root pnpm lockfile:

```bash
docker compose build api          # equivalent to: docker build -f server/Dockerfile .
```

The image is multi-stage: pnpm comes from Corepack with the version pinned in the root
`packageManager` field, TypeScript is compiled in a build stage, and the runtime stage carries only
production dependencies, runs as the unprivileged `node` user with `NODE_ENV=production`, and
health-checks itself against `/healthz`.

On a machine without an NVIDIA GPU (macOS in particular) set `WHISPER_IMAGE_TAG=latest-cpu` and
`WHISPER_DEVICE=cpu` in `.env` before starting, as described in `.env.example`.

The transcription worker is present in `docker-compose.yml` as a commented-out service: its
workspace does not exist yet, and an active service pointing at a missing build context would break
`docker compose up` for everyone. Uncomment it once that workspace lands.

**Dev flow (server on the host):** run only the infrastructure in containers and the API locally,
which keeps the fast edit/restart loop. The base compose file keeps Postgres and the MinIO S3 API
internal to the stack, so add `docker-compose.dev.yml`, which publishes both on the host (the ports
are configurable via `POSTGRES_PORT` / `MINIO_PORT` when they collide with local services):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  up -d postgres keycloak minio minio-init
pnpm --filter @quorum/server run build
pnpm --filter @quorum/server run start   # environment as described in server/README.md
```

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
