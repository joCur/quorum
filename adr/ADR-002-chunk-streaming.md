# ADR-002: Chunk-Streaming per WebSocket, Verarbeitung als Job

**Status:** Akzeptiert · **Datum:** 2026-08-29

## Kontext

Zwei Grundmuster für den Audio-Transport: (A) Upload nach Aufnahmeende oder (B) Streaming während der Aufnahme. Eine verlorene 90-Minuten-Aufnahme (Browser-Crash) ist der Worst Case für Nutzervertrauen. Live-Transkription ist eine attraktive spätere Ausbaustufe.

## Entscheidung

- **Streaming während der Aufnahme (B):** Der Client sendet Audio-Chunks (1–2 s) per WebSocket mit Sequenznummern; der Server puffert, persistiert und bestätigt.
- **Keine Live-Verarbeitung in V1:** Streaming dient nur der sicheren Ablage. Nach `session.end` finalisiert der Server die Audio-Datei und legt einen asynchronen Verarbeitungs-Job an (Job-API: anlegen → Status via Polling/SSE → Ergebnis).
- **Protokoll-Nachrichten:**
  - `session.start` (C→S): Meeting-Metadaten, Audio-Format (Codec, Samplerate, Kanäle, Container), Client-Info → Server antwortet `session.ready` mit Session-ID.
  - Audio-Chunks binär mit Header: Session-ID, Sequenznummer, Timestamp-Offset.
  - `chunk.ack` (S→C): letzte persistierte Sequenznummer. Client puffert unbestätigte Chunks lokal (IndexedDB) und sendet bei Reconnect ab dort weiter.
  - `session.end` (C→S): finalisiert Aufnahme, startet Job.
  - `transcript.partial` (S→C): im Schema reserviert, in V1 nie gesendet → Live-Transkript ist später rein additiv.
- **Codec:** Opus wie vom MediaRecorder geliefert (WebM/Ogg), kein Re-Encoding im Client. Safari-Sonderfall (AAC/MP4) wird über das Format in `session.start` abgefangen.
- **Pausen/Resumes** werden als Zeitmarken in den Session-Metadaten erfasst (Mapping Audio-Zeit ↔ Realzeit, siehe ADR-003).

## Konsequenzen

- Crash-Sicherheit: maximal die letzten unbestätigten Sekunden gehen verloren.
- Mehraufwand: Reconnect-Logik, serverseitige Session-Verwaltung.
- Fundament für Live-Transkript ohne dessen Komplexität jetzt zu bezahlen.
