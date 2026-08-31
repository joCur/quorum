# ADR-002: Chunk Streaming over WebSocket, Processing as a Job

**Status:** Accepted · **Date:** 2026-08-29

## Context

Two basic patterns for transporting audio: (A) upload after the recording ends, or (B) streaming during the recording. A lost 90-minute recording (a browser crash) is the worst case for user trust. Live transcription is an attractive later build-out stage.

## Decision

- **Streaming during the recording (B):** the client sends audio chunks (1–2 s) over WebSocket with sequence numbers; the server buffers, persists and acknowledges them.
- **No live processing in V1:** streaming serves only to store the audio safely. After `session.end` the server finalizes the audio file and creates an asynchronous processing job (job API: create → status via polling/SSE → result).
- **Protocol messages:**
  - `session.start` (C→S): meeting metadata, audio format (codec, sample rate, channels, container), client info → the server answers `session.ready` with a session ID.
  - Audio chunks, binary with a header: session ID, sequence number, timestamp offset.
  - `chunk.ack` (S→C): the last persisted sequence number. The client buffers unacknowledged chunks locally (IndexedDB) and continues from there on reconnect.
  - `session.end` (C→S): finalizes the recording, starts the job.
  - `transcript.partial` (S→C): reserved in the schema, never sent in V1 → a live transcript is purely additive later.
- **Codec:** Opus as delivered by the MediaRecorder (WebM/Ogg), no re-encoding in the client. The Safari special case (AAC/MP4) is caught via the format in `session.start`.
- **Pauses/resumes** are recorded as timestamps in the session metadata (mapping audio time ↔ real time, see ADR-003).

## Consequences

- Crash safety: at most the last unacknowledged seconds are lost.
- Extra effort: reconnect logic, server-side session management.
- A foundation for a live transcript without paying for its complexity now.
