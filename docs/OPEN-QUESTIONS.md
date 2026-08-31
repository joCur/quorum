# Quorum — Open Decisions & Operational Topics

> Deliberately **not** settled — proposals as a basis for discussion in the dev team. Decided together in week 1, each one recorded as an ADR.

## Tech Stack (open, with candidates)

| Building block | Candidates | Note |
|---|---|---|
| Server language/framework | TypeScript (Hono/Fastify/NestJS), alternatively .NET | TS shares the Zod schemas natively with the client; .NET would be close to the team's experience but would need schema generation |
| Web client | React + Vite (PWA) | Schemas from `shared/` are usable directly |
| Job queue | BullMQ (Redis) · pg-boss (Postgres) · RabbitMQ | The job API (ADR-002) presupposes a queue; pg-boss saves an infrastructure component |
| Database | PostgreSQL | JSONB for transcript/summary blobs + relational metadata |
| Object storage | MinIO (self-hosted) · S3-compatible | Server-side encryption is mandatory (ADR-001) |
| Auth provider | Zitadel · Keycloak · Ory | OIDC, Authorization Code + PKCE; self-hostable, matching the data sovereignty promise |
| Whisper serving | faster-whisper · whisperX (with word timestamps!) | whisperX delivers better word alignments — relevant because of ADR-003 §4 |
| Hosting | own server/Hetzner + GPU instance · k8s later | GPU sizing after the first load measurements |

## Observability & Operations (named, not yet decided)

Async pipelines fail silently — a stuck job means a user waiting forever for their transcript. To be clarified before production operation:

- Structured logs (JSON) correlating meeting↔session↔job
- Job metrics: queue depth, throughput time, failure rate, GPU utilization
- Retry semantics and dead-letter handling per job type (what is idempotent?)
- Alerting (e.g. a job older than X minutes in `queued`)
- Backup/restore for object storage and the database — including the deletion cascade in backups (ADR-001: removal after a defined period)
- Candidates: OpenTelemetry + the Grafana stack (Loki/Tempo/Prometheus), which fits the self-hosting approach

## Abuse and cost protection (decided; implemented)

The GPU worker is the most expensive attack target once strangers are on the system. Every item
that was open here is now built and documented in `server/README.md`:

- Per-user quotas — total stored audio and recorded hours per calendar month — summed from the
  meetings themselves rather than from counters, and enforced when a session starts.
- Three duration ceilings, each finalizing what exists instead of discarding it: recorded audio
  (the cost limit, which a pause does not spend), session lifetime in wall clock (which protects
  the open session itself), and how long a single pause may last before the meeting is closed as
  complete. Plus a maximum number of parallel sessions per user.
- Rate limits on the WebSocket (chunks/s and bytes/s, per connection) and on the REST API (per
  user, with a much smaller allowance on the one route that costs a model call).
- Server-side validation that incoming chunks match the announced audio format — this one was
  already in place with the recording endpoint.
- Queue fairness: a job is enqueued with a priority that ranks it behind the ones its user is
  already waiting on, so nobody monopolizes the workers.

Every limit is resolved per tenant and user through one resolver, which in V1 answers with the
environment configuration for everybody. What is still open is the tier structure on top of it:
which plans exist and what numbers each one gets.

## Cost model (to do before the pitch meeting)

Put together a rough calculation per meeting hour: GPU seconds for Whisper, LLM tokens for the summary (router prices), storage (Opus ~7–15 MB/h + transcripts). Result: cost per hour as the basis for plan prices and quotas.
