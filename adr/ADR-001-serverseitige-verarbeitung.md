# ADR-001: Serverseitige Verarbeitung mit Audio-Persistierung

**Status:** Akzeptiert · **Datum:** 2026-08-29

## Kontext

Die Anwendung zeichnet Meetings auf (live vor Ort und online) und erzeugt konfigurierbare Zusammenfassungen. Ursprünglich war ein Hybrid-Modell angedacht: lokale Verarbeitung im Browser (Sicherheit) vs. serverseitige Verarbeitung (Geschwindigkeit, Qualität). Die Anwendung soll als SaaS betrieben werden.

## Entscheidung

1. **V1 verarbeitet ausschließlich serverseitig.** Der lokale Verarbeitungspfad (Whisper im Browser via WASM/WebGPU) wird nicht gebaut, aber architektonisch offengehalten: Die Verarbeitungs-Pipeline (Aufnahme → Transkription → Diarisierung → Zusammenfassung) ist als Abstraktion mit definierten Input-/Output-Kontrakten geschnitten, sodass einzelne Schritte später clientseitig ausgeführt werden können.
2. **Rohaudio wird persistiert.** Nutzer können Aufnahmen nachhören; Audio ist Rohmaterial für Reprocessing mit besseren Modellen oder späterer Diarisierung.
3. **Sicherheitsversprechen:** "Wir speichern alles, aber ordentlich."
   - Verschlüsselung at rest für Audio, Transkripte und Summaries (Object Storage mit serverseitiger Verschlüsselung).
   - Löschkonzept ab Tag 1: Löschen eines Meetings kaskadiert auf Audio, Transkripte, Summaries und alle abgeleiteten Daten; Entfernung aus Backups nach definierter Frist.
   - Schema für Aufbewahrungsregeln pro Nutzer wird vorgesehen (z. B. "Audio nach 30 Tagen löschen, Transkript behalten"); Umsetzung folgt später.
4. **Spätere Nutzeroption:** Server (Standard) / Server ohne Audio-Speicherung / Lokal. Transkripte und Summaries werden als opake Blobs mit externen Metadaten gespeichert, damit clientseitige Verschlüsselung (E2E) später ohne Datenmodell-Umbau einführbar ist.

## Konsequenzen

- Deutlich reduzierter V1-Umfang; kein Browser-Whisper, kein Key-Management.
- Speicherkosten durch Audio (Opus mono ~7–15 MB/h) → Quotas pro Plan einplanen.
- DSGVO-Relevanz sobald fremde Nutzer: Löschkonzept und Verschlüsselung sind dafür das Fundament.
