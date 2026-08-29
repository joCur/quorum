# ADR-005: Modellstrategie — Self-hosted Whisper + OpenAI-kompatible API für Summaries

**Status:** Akzeptiert · **Datum:** 2026-08-29

## Kontext

Transkription und Zusammenfassung sind die beiden rechenintensiven Pipeline-Schritte. Die Wahl zwischen Self-Hosting und externen APIs bestimmt Betriebskosten und das Datenschutzversprechen ("eure Daten bleiben bei uns") zugleich.

## Entscheidung

1. **Transkription: self-hosted Whisper.** Audio ist das sensibelste Artefakt und verlässt die eigene Infrastruktur nicht.
2. **Summaries: OpenAI-kompatible API als Abstraktion.** Der Summary-Worker spricht ausschließlich das OpenAI-kompatible Chat-Completions-Format. Start mit einem gehosteten Router (z. B. OpenRouter); später Umstieg auf self-hosted Modelle (z. B. LM Studio, vLLM, Ollama) durch reinen Konfigurationswechsel (Base-URL + Modellname), ohne Codeänderung.
3. Modell- und Prompt-Version werden pro Transcript/Summary gespeichert (ADR-003/004) — Anbieterwechsel bleibt dadurch nachvollziehbar.

## Konsequenzen

- Übergangsweise verlassen Transkript-Texte (nicht Audio) die Infrastruktur Richtung Summary-API. Das ist eine bewusste, dokumentierte Einschränkung des Datenschutzversprechens bis zum Self-Hosting der LLMs — im Pitch und später in den Nutzungsbedingungen transparent machen.
- GPU-Kapazität für Whisper wird zur eigenen Betriebsverantwortung (Sizing, Queueing bei Lastspitzen → Job-API/Queue fängt das konzeptionell ab).
