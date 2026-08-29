# ADR-004: Summary-Templates mit Vererbung und Snapshot

**Status:** Akzeptiert · **Datum:** 2026-08-29

## Entscheidung

1. **Templates mit einer Vererbungsebene:** System-Template als allgemeiner Standard; Nutzer-Templates via `basedOn` mit Abschnitts-Overrides (hinzufügen/überschreiben/ausblenden). Scope: `system | user`, später erweiterbar um `team/org`.
2. **Snapshot statt Referenz:** Eine erzeugte Summary speichert die aufgelöste Template-Konfiguration plus Modell- und Prompt-Version als Kopie — spätere Template-Änderungen verfälschen nicht die Historie.
3. **1:n:** Ein Meeting kann mehrere Summaries haben (verschiedene Templates, Neugenerierung); eine aktive pro Template.
4. **Quellenverweise:** `sourceSegmentIds` pro Summary-Abschnitt (nullable, in V1 unbefüllt) — nutzt die stabilen Segment-IDs aus ADR-003.
5. **Strukturierter Output:** Summary als JSON (Abschnitte mit Inhalt), nicht als Markdown-Blob. Markdown-Export ist trivial abzuleiten; die Gegenrichtung nicht.
