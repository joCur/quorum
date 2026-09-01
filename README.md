# Quorum — Foundation (Schemas & ADRs)
> **Quorum** — meeting recording with transcription and configurable summaries, self-hosted first.

Meeting recording (in person & online) with configurable summaries, planned as a SaaS. A web application (desktop + mobile browser, PWA), with a wake lock held during the recording.

## Structure

- `docs/adr/` — Architecture Decision Records
  - ADR-001: Server-side processing, audio persistence, encryption at rest, the deletion concept
  - ADR-002: Chunk streaming over WebSocket, processing as an asynchronous job
  - ADR-003: Transcript data model (immutability, 1:n, word timestamps)
  - ADR-004: Summary templates (inheritance, snapshot, structured output)
  - ADR-005: Self-hosted Whisper + an OpenAI-compatible summary API
  - ADR-006: Stack decision (Fastify, React + Vite PWA, pg-boss, PostgreSQL, MinIO, whisperX, Keycloak)
  - ADR-007: Authentication stays on Keycloak; realm configuration becomes declarative
- `docs/PITCH.md` — why we are building this, the V1 demo definition, our legal position
- `docs/ROADMAP.md` — V1 → V2 → later (becomes GitHub issues at project start)
- `docs/OPEN-QUESTIONS.md` — stack proposals, observability, abuse protection (deliberately open)
- `docs/COST-MODEL.md` — cost per meeting hour (our own server vs. cloud)
- `docs/observability.md` — the structured log schema both services emit and the Prometheus
  metrics they expose (queue depth, job throughput, failure rate)
- `docs/runbooks/pipeline.md` — what to do when the pipeline misbehaves: retry and dead-letter
  semantics per job type, the dead-letter redrive procedure, and a response for every alert
- `docs/runbooks/backup-restore.md` — what to back up and how to restore it, the deletion window
  that backups have to honor, and how the MinIO KMS master key is kept and rotated
- `infra/monitoring/` — Prometheus, Alertmanager and Grafana as code, behind the opt-in
  `monitoring` compose profile
- `docker-compose.yml` + `docker-compose.gpu.yml` + `.env.example` — the self-hosting skeleton; a
  hardware change is purely an env change
- `docker-compose.release.yml` / `docker-compose.release-gpu.yml` + `docs/deployment.md` — the
  production stack. Installing it is one compose file plus a `.env`: every script, configuration
  file and the production realm is baked into the published images, and nothing is mounted from
  the host. Pick the CPU or the GPU file, never both.
- `shared/src/` — Zod schemas as the single source of truth for client & server
  - `recording-protocol.ts` — WebSocket control messages + the binary chunk format
  - `transcript.ts` — transcript, segments, speakers, word timestamps
  - `summary.ts` — templates, overrides, generated summaries with a snapshot
  - `job.ts` — the async job API (status, error format, result reference)

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
| `pnpm test`          | Vitest logic tests plus jsdom component behavior tests          |
| `pnpm run build`     | Builds every workspace that has a `build` script               |
| `pnpm run lint`      | ESLint plus a Prettier formatting check                        |
| `pnpm run format`    | Rewrites files with Prettier                                   |
| `pnpm run e2e`       | Playwright end-to-end suite against the compose stack           |
| `pnpm run dev:client` | Starts the PWA dev server on http://localhost:5173            |

Workspaces:

- `shared/` — package `@quorum/shared`, the zod schemas shared by client and server
- `server/` — package `@quorum/server`, the Fastify API: Keycloak JWT validation with a
  tenant-scoped request context, plus the WebSocket recording endpoint. See `server/README.md`
  for the scoping convention and the manual auth verification path.
- `worker/` — package `@quorum/worker`, the job worker turning recorded audio into transcripts.
  See `worker/README.md` for the transcription backends, the idempotency rules and the retry
  and dead-letter behavior.
- `client/` — package `@quorum/client`, the React + Vite PWA. See `client/README.md` for the
  local development flow and the dev proxy that keeps the app same-origin.
- `e2e/` — package `@quorum/e2e`, the Playwright suite covering the critical paths. `pnpm run e2e`
  from the repository root brings the stack up, runs the tests and tears it down again. See
  `e2e/README.md` for the options, the mocked-versus-real transcription trade-off, and the rule
  that a change to a critical path extends the suite.

### Web client

The PWA reads its configuration from `VITE_*` variables; copy `client/.env.example` to
`client/.env.local` and point `VITE_OIDC_ISSUER_URL` at the Keycloak realm before running
`pnpm run dev:client`. Leave `VITE_API_BASE_URL` empty: the dev server proxies `/api`, `/ws` and
`/healthz` to the API on port 8080, so the app is same-origin in development just as it is in a
deployment. Fonts and icons are bundled — the app makes no requests to any CDN at runtime, which
a self-hosted deployment depends on. `client/README.md` has the full flow.

Infrastructure configuration:

- `infra/keycloak/` — the versioned `quorum` realm imported by the `keycloak` service on startup
  (ADR-006 §7), so `git clone && docker compose up` yields a working login with no admin-console
  clicking. Dev-only test users are documented in `infra/keycloak/README.md`.
- `infra/postgres/init/` — provisions Keycloak's own logical database on the shared Postgres
  instance (no second database container).
- The development stack runs a `mailpit` container and the development realm sends account mail to
  it, so password reset is walkable end to end without a relay and without anything leaving the
  machine. The inbox is at <http://localhost:8025>. A deployment has no mail container — it points
  at the operator's own relay, or sends nothing at all (`docs/deployment.md`).

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

## Walking Skeleton Steps

The steps that took the repository from schemas to a running pipeline. All of them have landed;
they are kept here as the shape of the critical path:

1. Set up auth (OIDC via an off-the-shelf solution, Authorization Code + PKCE) — tenant/user scope in every data object from day one
2. Server: a WebSocket endpoint per `recording-protocol.ts`, persisting chunks in object storage, sending `chunk.ack`
3. Client: recording (getUserMedia + MediaRecorder), an IndexedDB buffer for unacknowledged chunks, reconnect from `persistedSeq`
4. Job worker: audio → Whisper → `Transcript` per the schema (including `words[]`)
5. Summary worker: system template → LLM → `Summary` with a template snapshot
6. E2E test of the critical path: recording → streaming → transcript → summary

Shared package: `@quorum/shared` (check the npm scope when setting up the repository). Dependency: `zod` (v3+).

## Local Development on macOS

Docker containers have **no GPU access** on a Mac (a Linux VM, no Metal) — the CUDA image and `docker-compose.gpu.yml` are moot there. Two ways:

1. **Default — the CPU image (full stack parity):** set the macOS profile in `.env` (`WHISPER_IMAGE_TAG=latest-cpu`, `WHISPER_DEVICE=cpu`, `WHISPER_MODEL=Systran/faster-whisper-small`, int8) and start the stack; the worker downloads that model on its first start, because the container serves no model it has not downloaded ([the deployment guide](docs/deployment.md) has the log lines and the failure cases). An identical compose setup to production — the right choice for integration and E2E tests.
2. **Speed mode — Whisper natively with Metal:** start whisper.cpp (`--server`) or mlx-whisper on the host, leave the Whisper container out, and set `WHISPER_BASE_URL=http://host.docker.internal:8080/v1` in the worker. Large-model quality, fast — for intensive work on the transcription pipeline. Thanks to the OpenAI-compatible abstraction (ADR-005), the worker notices no difference.

On Apple Silicon, watch out for arm64 images (speaches, Postgres and MinIO ship multi-arch), otherwise Rosetta emulation slows things down.
