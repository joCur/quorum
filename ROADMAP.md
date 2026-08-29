# Quorum — Roadmap

> Wird bei Projektstart als GitHub-Issues/Milestones ausgebreitet.

## V1 — Walking Skeleton bis Demo

1. Auth (OIDC, fertige Lösung, Authorization Code + PKCE) + Mandanten-/User-Scope in jedem Datenobjekt
2. WebSocket-Recording-Endpoint gemäß Protokoll (ADR-002), Persistierung in Object Storage, `chunk.ack`
3. Web-Client: Aufnahme (getUserMedia + MediaRecorder), Wake Lock, IndexedDB-Puffer, Reconnect ab `persistedSeq`
4. Job-Worker: Whisper-Transkription → Transcript-Schema (inkl. Wort-Timestamps)
5. Summary-Worker: System-Template → OpenAI-kompatible API → Summary mit Template-Snapshot
6. Meeting-Verwaltung: Liste, Nachhören, Transkript-Ansicht, vollständiges Löschen (Kaskade)
7. Nutzer-Templates (basedOn + Overrides)
8. E2E-Tests der kritischen Pfade: Aufnahme→Transkript→Summary, Auth-Flows, Löschen

## V2 — Ausbau

- Transkript-Korrekturen im UI (editedText/editedSpeakerId, Original bleibt erhalten)
- Reprocessing-Feature (neues Modell auf altes Audio, 1:n-Transcripts)
- Live-Transkript (`transcript.partial` aktivieren)
- Aufbewahrungsregeln pro Nutzer (Auto-Löschung Audio)
- Quotas/Limits pro Plan

## Später / nach Compliance-Prüfung

- Sprecher-Diarisierung
- Sprecherprofile zur Wiedererkennung (biometrische Daten, Art. 9 DSGVO — bewusste Compliance-Entscheidung)
- Lokaler Verarbeitungspfad (Browser-Whisper) als dritte Nutzeroption
- Self-hosted Summary-LLMs (Konfigwechsel dank OpenAI-kompatibler Abstraktion, ADR-005)
- PII-Redaction als Overlay
- Team-/Org-Scope für Templates
