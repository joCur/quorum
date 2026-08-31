# Quorum — Pitch: Why We Are Building This Ourselves

## Problem

Meeting recording with automatic transcription and summarization exists as a product category (Otter, Fireflies, tl;dv, …) — but consistently as US cloud services: the audio and conversation data sits with third parties, the summarization logic is a black box, and self-hosting is not on offer.

## Why Build It Ourselves

1. **Data sovereignty as the core promise.** Meeting content is highly sensitive. Audio is transcribed exclusively on our own infrastructure (self-hosted Whisper, ADR-005); the goal is a fully self-hosted pipeline. For privacy-sensitive users and industries, that is the differentiator against the established providers.
2. **Configurability as the product core.** Summaries are template-based per user (ADR-004) instead of one-size-fits-all — from the system default to a user's own section layout.
3. **Understanding and extensibility.** We control every stage of the pipeline and can take the system into more specialized contexts where off-the-shelf SaaS cannot be used.
4. **An extensible foundation:** speaker recognition (diarization) and, further out, speaker profiles for re-identification are already accounted for in the data model and the architecture (ADR-003), without weighing V1 down.

## V1 Demo Definition

Record a meeting in the browser (desktop and mobile, PWA) → the recording is streamed crash-safely (ADR-002) → once the meeting ends, a transcript and a summary based on your own template are available → the recording can be listened back to → the meeting can be deleted completely (cascade, ADR-001).

## Legal Framing (Our Position)

- **Consent of the conversation participants** is the responsibility of the recording user — technically we cannot show anything to participants outside our app. The product points the user clearly at that obligation (a notice in the recording flow and in the terms of use).
- Because this is sensitive data, **privacy is an implementation principle, not a feature**: encryption at rest, real deletion including backups, tenant separation from day one (ADR-001).
- Speaker profiles for re-identification are biometric data (Art. 9 GDPR) — that feature will only be built after a deliberate compliance review and is therefore roadmap, not V1.

## Architecture in One Paragraph

The web client (PWA) streams audio chunks to the server over WebSocket, crash-safely (ADR-002). Processing runs as asynchronous jobs through a pipeline with defined contracts: Whisper transcription (self-hosted) → summary via an OpenAI-compatible API (ADR-005). All data formats are versioned Zod schemas and the single source of truth for client and server; machine output is immutable, user corrections are overlays, and Meeting→Transcript→Summary is 1:n throughout (ADR-003/004) — which makes reprocessing with better models a feature rather than a migration.
