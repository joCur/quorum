# ADR-006: Stack Decision (Server, Web Client, Queue, Database, Object Storage, Whisper Serving, Auth Provider)

**Status:** Accepted · **Date:** 2026-08-29

## Context

`OPEN-QUESTIONS.md` deliberately left the technology stack open, with candidates per building block. The walking skeleton (ROADMAP.md V1) cannot start until these are fixed, because every follow-up ticket — WebSocket recording endpoint, job worker, auth flows — depends on them. The lead proposed a set that the PO has accepted; this ADR records the team evaluation of each candidate group and the resulting decision.

Constraints that apply to every choice:

- **Self-hosted first.** Everything a customer needs to run must be startable from our own `docker-compose.yml`, with no vendor account required (PITCH.md, ADR-005).
- **`shared/src/` (Zod) is the single source of truth.** Client and server import the same schemas rather than duplicating them (CLAUDE.md).
- **Every long-running operation is a server-side job** (ADR-002, `shared/src/job.ts`).
- **Encryption at rest and cascading deletion** are mandatory from day one (ADR-001).
- **Operational simplicity outranks theoretical scalability** at this stage: fewer moving infrastructure parts means fewer ways for the async pipeline to fail silently.

## Decision

### 1. Server: TypeScript + Fastify

**Decided: Fastify on Node.js (TypeScript).**

The decisive argument is native schema sharing: the Zod schemas in `shared/src/` are consumed unchanged by both the server and the PWA, so a protocol change (e.g. `recording-protocol.ts`) breaks the type check on both sides in the same commit. **Hono** is leaner and edge-friendly, but we do not deploy to the edge, and its WebSocket story depends on the runtime adapter — for a long-lived, stateful chunk-streaming connection (ADR-002) Fastify's mature `@fastify/websocket` plus a plugin/lifecycle model we will actually need (auth, rate limits, request-scoped logging) is worth more than the bundle size. **NestJS** brings structure we would otherwise write ourselves, but the decorator/DI layer adds ceremony and pulls toward `class-validator` instead of the Zod schemas we already own. **.NET** is closest to the team's existing experience and would be a defensible choice on its own merits, but it would force schema generation or hand-maintained DTOs across the language boundary — reintroducing exactly the duplication CLAUDE.md forbids, on the most safety-critical artifact we have.

**Counter-argument, honestly stated:** the .NET option is not weak — it is stronger than TypeScript on CPU-bound work, long-running processes, and static typing discipline. We accept a Node.js runtime whose weakest point is CPU-bound audio handling; this is tolerable because the heavy work (Whisper, LLM) happens outside the Node process and the API only moves bytes to object storage.

### 2. Web client: React + Vite, installable PWA

**Decided: React + Vite, PWA (`vite-plugin-pwa`).**

The client's hard requirements come from ADR-002: `getUserMedia`/`MediaRecorder`, Wake Lock, an IndexedDB buffer for unacknowledged chunks, and reconnect from `persistedSeq`. None of these favor a particular framework; what does favor React is the ecosystem depth for the parts we do not want to invent (data fetching, forms for the template editor of ADR-004) and the availability of engineers. Vite gives us a fast dev loop and, via `vite-plugin-pwa`, a service worker without hand-rolling Workbox config. A PWA — rather than native apps — is the right call because recording happens in the browser anyway and we avoid two app-store release paths.

**Known limitation:** iOS Safari remains the constraining platform (MediaRecorder produces AAC/MP4 instead of WebM/Opus — already handled by the format field in `session.start` — and background/lock-screen recording is restricted). That is a platform property, not a framework property, so it does not change the choice.

### 3. Job queue: pg-boss

**Decided: pg-boss on the existing PostgreSQL instance.**

PostgreSQL is required regardless, so pg-boss adds a queue with zero new infrastructure components, and — the underrated part — job state changes become transactional with the domain data: enqueueing a `transcribe` job and writing the meeting row commit together, so we cannot end up with a job for a meeting that does not exist. **BullMQ** is faster and has the better dashboard, but it costs a Redis service that must be deployed, monitored, backed up, and explained to every self-hoster; Redis as a queue also needs deliberate persistence configuration to not lose jobs. **RabbitMQ** offers routing and delivery semantics far beyond what a handful of job types (`transcribe`, `summarize`) require, at a much higher operational cost.

**Where this could bite us:** pg-boss polls, so queue latency is on the order of hundreds of milliseconds to seconds, and throughput is bounded by Postgres. For our workload — a few jobs per meeting, each running for minutes on a GPU — both are irrelevant; the queue will never be the bottleneck. If we ever reach a scale where it is, migrating is contained because the worker talks to `shared/src/job.ts`, not to the queue library, across the codebase.

### 4. Database: PostgreSQL (JSONB blobs + relational metadata)

**Decided: PostgreSQL 17, one instance for domain data and queue.**

Transcripts and summaries are versioned, schema-validated documents (ADR-003/004) that we read as a whole and rarely query field-by-field; they are stored as JSONB blobs, while the queryable metadata (tenant, user, meeting, model/prompt version, `schemaVersion`, active-transcript flag) lives in relational columns with real foreign keys. Those foreign keys are what makes the ADR-001 deletion cascade auditable rather than a best-effort loop in application code. This also keeps the ADR-001 door open for later client-side encryption: the blob can become opaque without touching the relational metadata around it. A document database would fit the blobs but not the cascade; splitting into two stores would buy nothing and cost consistency.

### 5. Object storage: MinIO, S3-compatible, server-side encryption mandatory

**Decided: MinIO in the compose stack, accessed only through the S3 API, with server-side encryption enabled.**

Audio is the most sensitive artifact we hold (ADR-001) and the largest by far (Opus ~7–15 MB/h). Talking S3 and nothing else means a self-hoster runs MinIO while a hosted deployment can point at S3, Ceph/RGW, or Garage by changing `S3_ENDPOINT` — no code path differs. Encryption at rest is not optional: buckets are created with default SSE, so an object cannot be written unencrypted by accident. Chunk persistence (ADR-002) uses multipart upload so a long recording is finalized rather than re-uploaded.

**To be settled in the infra ticket, not here:** key management (MinIO SSE-KMS via KES vs. SSE-S3 with a static key) and the backup/restore path including deletion propagation into backups (ADR-001).

### 6. Whisper serving: whisperX, behind the OpenAI-compatible abstraction

**Decided: whisperX for transcription — but strictly behind the OpenAI-compatible endpoint contract of ADR-005.**

ADR-003 §4 makes word-level timestamps a day-one requirement, and that is precisely where the two candidates differ: **faster-whisper** derives word timings from cross-attention, which is good enough for reading but drifts; **whisperX** runs a separate forced-alignment pass (wav2vec2) on top of faster-whisper, producing word boundaries accurate enough for click-on-word playback, precise highlights, and — later — assigning diarization results to words. whisperX also has VAD-based batching, so it is typically faster on long recordings, and the diarization we deferred to a post-compliance milestone is already part of its pipeline. Cost: an extra alignment model per language, more VRAM, and a heavier image.

**This is the choice I want to flag most clearly.** whisperX is a library and CLI, not an OpenAI-compatible server — unlike `speaches`, which the current `docker-compose.yml` uses today precisely because it exposes `/v1/audio/transcriptions` out of the box. Adopting whisperX therefore means we own a thin serving wrapper (FastAPI) that speaks the OpenAI transcription API with `response_format=verbose_json` and `timestamp_granularities=["word","segment"]`, and we own its maintenance. The abstraction from ADR-005 is what makes this safe: the worker only ever sees `WHISPER_BASE_URL`, so swapping whisperX for `speaches`/faster-whisper — or for a hosted endpoint — is a configuration change. **Consequence for sequencing:** the walking skeleton may start against `speaches` to keep the pipeline unblocked, and swap in whisperX once the wrapper exists; the transcript schema (`words[]`) is identical either way. Alignment quality is then a measurable improvement, not a rewrite.

**macOS development path (README.md):** Docker on macOS has no GPU access, so the CUDA image is meaningless there. Both documented paths remain valid unchanged, because the worker only knows a base URL: (1) the CPU image with a `small`/int8 model for full stack parity in integration and E2E tests, or (2) whisper.cpp `--server` / mlx-whisper natively on the host with Metal and `WHISPER_BASE_URL=http://host.docker.internal:8080/v1` for speed. Note that path (2) gives faster-whisper-grade word timings, not whisperX alignment — fine for feature work, not for judging alignment quality.

### 7. Auth provider: Keycloak

**Decided: Keycloak, running inside the compose stack, configured as code via `--import-realm`.**

The decisive criterion is not the protocol — all three candidates do OIDC with Authorization Code + PKCE — but developer experience and reproducibility. Keycloak imports a **versioned realm JSON at startup** (`--import-realm`), so `git clone && docker compose up` yields a working login with our realm, clients, roles, and redirect URIs already in place: no manual clicking in an admin UI, no undocumented state, and realm changes arrive as reviewable diffs in pull requests. That is the PO's explicit DevX requirement and it directly feeds the auth setup ticket. **Zitadel** is the more modern product with a nicer admin experience and multi-tenancy built in, but its bootstrap depends on init/setup steps plus a management API, which is a scriptable but noticeably more moving-parts path to a reproducible dev environment. **Ory** (Hydra + Kratos + Keto) is the cleanest architecture and the most composable, but it is several services rather than one and expects us to build the login/consent UI ourselves — real work we do not want in the walking skeleton.

**Counter-argument, honestly stated:** Keycloak is heavy — a JVM service with noticeable memory use and startup time in a stack that also runs Postgres, MinIO, and a Whisper container, which is felt most on developer laptops. We accept that; it buys a mature, well-documented OIDC implementation and reproducible configuration. Keycloak gets its own logical database on the shared Postgres instance (separate database, separate user) rather than its own container — one less service, and its schema stays isolated from the domain schema.

## Deliberately not decided here

- **Observability stack** (OpenTelemetry + Grafana/Loki/Tempo/Prometheus) — named in `OPEN-QUESTIONS.md`, decided before production, not needed to start the skeleton.
- **ORM/query layer** (Drizzle vs. Kysely vs. plain SQL) and the migration tool — an implementation detail of the API ticket, not an architectural commitment.
- **Reverse proxy and TLS** (Caddy vs. Traefik) and **hosting** (single server vs. later k8s) — infra tickets; GPU sizing follows the first load measurements.
- **Abuse and cost protection** (quotas, rate limits, job fairness) — named in `OPEN-QUESTIONS.md`, scheduled for V2.

## Consequences

- Follow-up tickets can now name concrete technologies; the auth setup starts from Keycloak with a versioned realm export in the repo.
- One language across server, worker, and client: shared Zod schemas, one toolchain, one test runner — at the price of Node.js as the runtime for all backend work.
- Infrastructure stays at four self-hosted services (Postgres, MinIO, Whisper, Keycloak) plus our own API and worker. No Redis, no separate broker.
- Postgres becomes a single point of failure for domain data *and* the queue: if it is down, nothing is enqueued and nothing runs. That is an accepted, explicit trade — backups and monitoring for Postgres therefore rank highest in the operations ticket.
- We take on maintenance of a small OpenAI-compatible serving wrapper around whisperX. If that turns out to be more burden than the alignment quality is worth, ADR-005's abstraction lets us fall back to `speaches`/faster-whisper by configuration; this ADR should then be superseded, not silently ignored.
- Every choice remains runnable without a vendor account, which keeps the "self-hosted first" promise of PITCH.md intact.

## Consequences for `docker-compose.yml`

Described here, **not implemented in this ADR** — the change belongs to the infra ticket.

- **Added: `keycloak`** — official image, started with `start --import-realm`, realm JSON mounted read-only from a versioned directory in the repo (e.g. `./infra/keycloak/realms/quorum-realm.json`). Uses the shared `postgres` service with its own database and user (`KC_DB=postgres`), `depends_on: postgres (service_healthy)`, admin console port published for local development only, and a health check on `/health/ready` so `api` can wait for a ready issuer.
- **Changed: `api`** — `OIDC_ISSUER_URL` now points at the internal Keycloak service (`http://keycloak:8080/realms/quorum`) instead of an external value in `.env`; a separate public issuer URL is needed for browser-facing redirects, since the container-internal hostname is not resolvable from the client. `depends_on` gains `keycloak`.
- **Changed: `postgres`** — must provision a second database for Keycloak (init script or an explicit bootstrap step). Also hosts the pg-boss schema; no configuration change needed for that beyond the queue's own migrations, which pg-boss runs itself on worker start.
- **Changed: `whisper`** — target image becomes our whisperX-based OpenAI-compatible serving image (`build:` of an `infra/whisper` context) instead of `ghcr.io/speaches-ai/speaches`. The service name, the internal contract (`WHISPER_BASE_URL=http://whisper:8000/v1`), the model cache volume, and the `docker-compose.gpu.yml` override all stay as they are. Additional environment for the alignment stage (alignment model/language, batch size, compute type); the model cache volume must also hold the alignment models. Until that image exists, the `speaches` image stays in place — the worker cannot tell the difference.
- **Unchanged: `minio`** — plus a bucket bootstrap step that enables default server-side encryption on the bucket (ADR-001), rather than relying on clients to request it.
- **Not added: `redis`** — deliberately absent; the existing comment in `docker-compose.yml` pointing to pg-boss is now backed by this ADR.
- The macOS notes in `README.md` remain valid; the CPU profile then refers to the CPU variant of the whisperX image.
