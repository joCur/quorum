# ADR-003: Transcript Data Model — Immutability, 1:n, Future-Proof Fields

**Status:** Accepted · **Date:** 2026-08-29

## Context

The transcript is the central artifact every further feature builds on (summaries, diarization, corrections, highlights, redaction). Schema mistakes at this point get expensive as the data set grows.

## Decision

1. **Stable segment IDs:** every segment has its own ID (not an array index). References (comments, highlights, summary source references) point at segment IDs.
2. **Machine output is immutable:** `text` is unchangeable; user corrections sit beside it (`editedText`), never on top of it. The same principle applies to speaker assignments. Redaction is realized later as an overlay (masking on delivery), never destructively.
3. **Meeting → Transcript is 1:n:** reprocessing (a new model, diarization) produces a new transcript; one is "active" per meeting. `model`/`modelVersion` and `schemaVersion` are stored per transcript.
4. **Word-level timestamps from day one:** an optional `words[]` (word, start, end) per segment is stored during transcription even without a UI feature — the basis for click-on-a-word, precise highlights and diarization assignment.
5. **Real-time mapping:** `recordedAt` (the absolute start time) on the transcript, plus pause/resume timestamps from the session metadata (ADR-002).
6. **Language per segment optional:** `language` at transcript level as the default, overridable per segment (multilingual meetings).
7. **Speakers as their own list:** `speakers[]` at transcript level (id, label, later a profile reference); segments reference `speakerId` (nullable until diarization exists).

## Deliberately Not Now

Chapters/topics, sentiment, multi-track audio — all retrofittable additively as their own objects alongside the segments.

## Consequences

- User corrections have to be mapped onto new transcripts on reprocessing — the problem is known, a solution will be designed when needed; the 1:n structure makes it possible.
- Somewhat more storage (word timestamps), but no expensive migrations in exchange.
