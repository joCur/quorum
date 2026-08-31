# ADR-001: Server-Side Processing with Audio Persistence

**Status:** Accepted · **Date:** 2026-08-29

## Context

The application records meetings (in person and online) and produces configurable summaries. A hybrid model was originally considered: local processing in the browser (security) vs. server-side processing (speed, quality). The application is meant to be operated as a SaaS.

## Decision

1. **V1 processes exclusively server-side.** The local processing path (Whisper in the browser via WASM/WebGPU) will not be built, but is kept open architecturally: the processing pipeline (recording → transcription → diarization → summarization) is cut as an abstraction with defined input/output contracts, so that individual steps can later be executed client-side.
2. **Raw audio is persisted.** Users can listen back to recordings; audio is the raw material for reprocessing with better models or for diarization later on.
3. **The security promise:** "We store everything, but properly."
   - Encryption at rest for audio, transcripts and summaries (object storage with server-side encryption).
   - A deletion concept from day one: deleting a meeting cascades to audio, transcripts, summaries and all derived data; removal from backups after a defined period.
   - A schema for per-user retention rules is provided for (e.g. "delete audio after 30 days, keep the transcript"); the implementation follows later.
4. **A later user option:** server (default) / server without audio storage / local. Transcripts and summaries are stored as opaque blobs with external metadata, so that client-side encryption (E2E) can be introduced later without rebuilding the data model.

## Consequences

- A significantly reduced V1 scope; no in-browser Whisper, no key management.
- Storage cost from audio (Opus mono ~7–15 MB/h) → plan for per-plan quotas.
- GDPR relevance as soon as there are outside users: the deletion concept and encryption are the foundation for it.
