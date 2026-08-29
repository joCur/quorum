# ADR-003: Transcript-Datenmodell — Immutability, 1:n, zukunftssichere Felder

**Status:** Akzeptiert · **Datum:** 2026-08-29

## Kontext

Das Transkript ist das zentrale Artefakt, auf dem alle weiteren Features aufbauen (Summaries, Diarisierung, Korrekturen, Highlights, Redaction). Schema-Fehler an dieser Stelle werden mit wachsendem Datenbestand teuer.

## Entscheidung

1. **Stabile Segment-IDs:** Jedes Segment hat eine eigene ID (kein Array-Index). Referenzen (Kommentare, Highlights, Summary-Quellenverweise) zeigen auf Segment-IDs.
2. **Maschinen-Output ist immutable:** `text` ist unveränderlich; Nutzerkorrekturen liegen daneben (`editedText`), nie darüber. Gleiches Prinzip für Sprecherzuordnungen. Redaction wird später als Overlay realisiert (Maskierung bei Auslieferung), nie destruktiv.
3. **Meeting → Transcript ist 1:n:** Reprocessing (neues Modell, Diarisierung) erzeugt ein neues Transcript; eines ist pro Meeting "aktiv". `model`/`modelVersion` und `schemaVersion` werden pro Transcript gespeichert.
4. **Wort-Level-Timestamps ab Tag 1:** Optionales `words[]` (word, start, end) pro Segment wird beim Transkribieren mitgespeichert, auch ohne UI-Feature — Grundlage für Klick-aufs-Wort, präzise Highlights, Diarisierungs-Zuordnung.
5. **Realzeit-Mapping:** `recordedAt` (absoluter Startzeitpunkt) am Transcript plus Pausen-/Resume-Zeitmarken aus den Session-Metadaten (ADR-002).
6. **Sprache pro Segment optional:** `language` auf Transcript-Ebene als Default, überschreibbar pro Segment (gemischtsprachige Meetings).
7. **Sprecher als eigene Liste:** `speakers[]` auf Transcript-Ebene (id, label, später Profil-Referenz); Segmente referenzieren `speakerId` (nullable bis Diarisierung existiert).

## Bewusst nicht jetzt

Kapitel/Topics, Sentiment, Mehrspur-Audio — additiv nachrüstbar als eigene Objekte neben den Segmenten.

## Konsequenzen

- Nutzerkorrekturen müssen bei Reprocessing auf neue Transcripts gemappt werden — Problem ist bekannt, Lösung wird bei Bedarf entworfen; die 1:n-Struktur macht sie möglich.
- Etwas mehr Speicher (Wort-Timestamps), dafür keine teuren Migrationen.
