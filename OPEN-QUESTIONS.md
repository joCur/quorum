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

## Missbrauchs- & Kostenschutz (benannt, noch keine Entscheidung)

Sobald fremde Nutzer auf dem System sind, ist der GPU-Worker das teuerste Angriffsziel:

- Upload-Quotas pro Nutzer/Plan (Speicher gesamt, Stunden pro Monat)
- Maximale Meeting-/Session-Dauer und maximale parallele Sessions pro Nutzer
- Rate Limits am WebSocket (Chunks/s, Bytes/s) und an der REST-API
- Serverseitige Validierung, dass eingehende Chunks dem angemeldeten Audio-Format entsprechen (kein beliebiger Blob-Upload)
- Job-Priorisierung/Fairness, damit ein Nutzer die Queue nicht monopolisiert

## Kostenmodell (To-do vor dem Pitch-Termin)

Grobe Rechnung pro Meeting-Stunde aufstellen: GPU-Sekunden Whisper, LLM-Tokens Summary (Routerpreise), Storage (Opus ~7–15 MB/h + Transkripte). Ergebnis: Kosten/Stunde als Grundlage für Plan-Preise und Quotas.
