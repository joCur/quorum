# Quorum — Kostenmodell pro Meeting-Stunde

Stand: 2026-08 · Grundlage für Pitch und spätere Plan-Preise/Quotas.

## Variante A: Eigener Server (Startphase, Docker Compose)

| Posten | pro Meeting-Stunde |
|---|---|
| Strom Whisper-Transkription (GPU, grob 0,15–0,2 kWh) | ~0,05–0,08 € |
| Summary via OpenRouter (12–15k Input- / 1–2k Output-Tokens) | ~0,01–0,05 € |
| Storage (Opus ~15 MB/h, lokal) | ~0 € |
| **Grenzkosten** | **~0,10 €** |

Keine Fixkosten außer vorhandener Hardware. GTX 1050 = small-Qualität (Entwicklung);
nach Upgrade auf 4070 Ti Super large-v3-Qualität, ~12–18x Echtzeit geschätzt,
Bestandsmeetings per Reprocessing rückwirkend verbesserbar (ADR-003).

## Variante B: Cloud (Hetzner, sobald echte Last)

Referenz: GEX44 (RTX 4000 SFF Ada, 20 GB) ≈ 232 €/Monat netto bzw. ~0,37 €/GPU-Stunde;
Object Storage ~6,50 €/Monat für 1 TB (≈ 65.000 Meeting-Stunden Audio).

| Posten | pro Meeting-Stunde |
|---|---|
| Transkription (large-v3, konservativ 6x Echtzeit → 10 min GPU) | ~0,06 € |
| Summary (OpenRouter, Standard-Modell) | ~0,01–0,05 € |
| Storage (laufend) | ~0,0001 €/Monat |
| **Grenzkosten** | **~0,10 €** |

**Fixkosten-Realität:** Die Grenzkosten gelten bei ausgelasteter GPU. Bei z. B. 200
Meeting-Stunden/Monat liegen die effektiven Kosten bei ~1,20 €/h (GPU-Fixkosten
verteilt). Entlastung: stundenweise Abrechnung ohne Mindestlaufzeit (GPU nur bei
Bedarf, Queue puffert) oder CPU-Transkription in der Frühphase.

## Pitch-Aussage

Grenzkosten ~0,10 € pro Meeting-Stunde; Fixkosten 0 € (eigener Server) bis
~230 €/Monat (dedizierte Cloud-GPU). Ab wenigen hundert Meeting-Stunden pro Monat
ist jedes realistische Abo-Modell deutlich profitabel.

## To-do nach Hardware-Test

4070 Ti Super real vermessen: whisperX inkl. Wort-Alignment (ADR-003-Anspruch) und
VAD mitlaufen lassen, VRAM und echte Durchlaufzeit notieren → Zahlen hier ersetzen.
