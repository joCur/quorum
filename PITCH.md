# Quorum — Pitch: Warum wir das selbst bauen

## Problem

Meetingaufzeichnung mit automatischer Transkription und Zusammenfassung existiert als Produktkategorie (Otter, Fireflies, tl;dv, …) — aber durchweg als US-Cloud-Dienste: Die Audio- und Gesprächsdaten liegen bei Dritten, die Zusammenfassungslogik ist eine Blackbox, Self-Hosting gibt es nicht.

## Warum selbst bauen

1. **Datenhoheit als Kernversprechen.** Meetinginhalte sind hochsensibel. Audio wird ausschließlich auf eigener Infrastruktur transkribiert (self-hosted Whisper, ADR-005); Ziel ist die vollständig self-hosted Pipeline. Für datenschutzsensible Nutzer und Branchen ist das das Alleinstellungsmerkmal gegenüber den etablierten Anbietern.
2. **Konfigurierbarkeit als Produktkern.** Zusammenfassungen sind nutzerspezifisch template-basiert (ADR-004) statt one-size-fits-all — vom System-Standard bis zum eigenen Abschnittslayout pro Nutzer.
3. **Verständnis und Erweiterbarkeit.** Wir kontrollieren jede Pipeline-Stufe und können das System in speziellere Kontexte bringen, in denen Standard-SaaS nicht einsetzbar ist.
4. **Erweiterbare Basis:** Sprecher-Erkennung (Diarisierung) und perspektivisch Sprecherprofile zur Wiedererkennung sind in Datenmodell und Architektur bereits vorgesehen (ADR-003), ohne V1 zu belasten.

## V1-Demo-Definition

Meeting im Browser aufnehmen (Desktop und Mobile, PWA) → Aufnahme wird crash-sicher gestreamt (ADR-002) → nach Meeting-Ende liegen Transkript und Summary nach eigenem Template vor → Aufnahme ist nachhörbar → Meeting ist vollständig löschbar (Kaskade, ADR-001).

## Rechtlicher Rahmen (Haltung)

- Die **Einwilligung der Gesprächsteilnehmer** liegt in der Verantwortung des aufzeichnenden Nutzers — technisch können wir Teilnehmern außerhalb unserer App nichts anzeigen. Das Produkt weist den Nutzer klar auf diese Pflicht hin (Hinweis im Aufnahme-Flow und in den Nutzungsbedingungen).
- Da es sich um sensible Daten handelt, ist **Datenschutz Umsetzungsprinzip, nicht Feature**: Verschlüsselung at rest, echtes Löschen inkl. Backups, Mandantentrennung ab Tag 1 (ADR-001).
- Sprecherprofile zur Wiedererkennung sind biometrische Daten (Art. 9 DSGVO) — das Feature wird erst nach bewusster Compliance-Prüfung umgesetzt und ist deshalb Roadmap, nicht V1.

## Architektur in einem Absatz

Web-Client (PWA) streamt Audio-Chunks per WebSocket crash-sicher zum Server (ADR-002). Verarbeitung läuft als asynchrone Jobs über eine Pipeline mit definierten Kontrakten: Whisper-Transkription (self-hosted) → Summary via OpenAI-kompatible API (ADR-005). Alle Datenformate sind als versionierte Zod-Schemas Single Source of Truth für Client und Server; Maschinen-Output ist immutabel, Nutzerkorrekturen sind Overlays, Meeting→Transcript→Summary ist durchgängig 1:n (ADR-003/004) — Reprocessing mit besseren Modellen ist damit ein Feature, keine Migration.
