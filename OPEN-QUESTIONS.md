# Quorum — Offene Entscheidungen & Betriebsthemen

> Bewusst **nicht** festgelegt — Vorschläge als Diskussionsgrundlage fürs Dev-Team. Entscheidung gemeinsam in Woche 1, jeweils als ADR festhalten.

## Tech-Stack (offen, mit Kandidaten)

| Baustein | Kandidaten | Anmerkung |
|---|---|---|
| Server-Sprache/Framework | TypeScript (Hono/Fastify/NestJS), alternativ .NET | TS teilt die Zod-Schemas nativ mit dem Client; .NET wäre teamnah, bräuchte aber Schema-Generierung |
| Web-Client | React + Vite (PWA) | Schemas aus `shared/` direkt nutzbar |
| Job-Queue | BullMQ (Redis) · pg-boss (Postgres) · RabbitMQ | Job-API (ADR-002) setzt eine Queue voraus; pg-boss spart eine Infrastruktur-Komponente |
| Datenbank | PostgreSQL | JSONB für Transcript-/Summary-Blobs + relationale Metadaten |
| Object Storage | MinIO (self-hosted) · S3-kompatibel | Serverseitige Verschlüsselung Pflicht (ADR-001) |
| Auth-Provider | Zitadel · Keycloak · Ory | OIDC, Authorization Code + PKCE; self-hostbar passend zum Datenhoheits-Versprechen |
| Whisper-Serving | faster-whisper · whisperX (mit Wort-Timestamps!) | whisperX liefert bessere Wort-Alignments — relevant wegen ADR-003 §4 |
| Hosting | eigener Server/Hetzner + GPU-Instanz · später k8s | GPU-Sizing nach ersten Lastmessungen |

## Observability & Betrieb (benannt, noch keine Entscheidung)

Async-Pipelines scheitern leise — ein hängender Job heißt: Nutzer wartet endlos auf sein Transkript. Vor Produktivbetrieb zu klären:

- Strukturierte Logs (JSON) mit Korrelation Meeting↔Session↔Job
- Job-Metriken: Queue-Länge, Durchlaufzeit, Fehlerrate, GPU-Auslastung
- Retry-Semantik und Dead-Letter-Handling pro Job-Typ (was ist idempotent?)
- Alerting (z. B. Job älter als X Minuten in `queued`)
- Backup/Restore für Object Storage und DB — inkl. Löschkaskade in Backups (ADR-001: Entfernung nach definierter Frist)
- Kandidaten: OpenTelemetry + Grafana-Stack (Loki/Tempo/Prometheus), passt zum Self-Hosting-Ansatz

## Abuse and cost protection (decided; implemented)

The GPU worker is the most expensive attack target once strangers are on the system. Every item
that was open here is now built and documented in `server/README.md`:

- Per-user quotas — total stored audio and recorded hours per calendar month — summed from the
  meetings themselves rather than from counters, and enforced when a session starts.
- Maximum session duration, with a server-side hard stop that finalizes what exists instead of
  discarding it, and a maximum number of parallel sessions per user.
- Rate limits on the WebSocket (chunks/s and bytes/s, per connection) and on the REST API (per
  user, with a much smaller allowance on the one route that costs a model call).
- Server-side validation that incoming chunks match the announced audio format — this one was
  already in place with the recording endpoint.
- Queue fairness: a job is enqueued with a priority that ranks it behind the ones its user is
  already waiting on, so nobody monopolizes the workers.

Every limit is resolved per tenant and user through one resolver, which in V1 answers with the
environment configuration for everybody. What is still open is the tier structure on top of it:
which plans exist and what numbers each one gets.

## Kostenmodell (To-do vor dem Pitch-Termin)

Grobe Rechnung pro Meeting-Stunde aufstellen: GPU-Sekunden Whisper, LLM-Tokens Summary (Routerpreise), Storage (Opus ~7–15 MB/h + Transkripte). Ergebnis: Kosten/Stunde als Grundlage für Plan-Preise und Quotas.
