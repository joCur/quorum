# ADR-010: Transcript Corrections Live Beside the Transcript, Not Inside It

**Status:** Accepted · **Date:** 2026-09-02

## Context

ADR-003 §2 settles the principle: machine output is immutable, and a user correction sits beside it
(`editedText`, `editedSpeakerId`) rather than on top of it. The segment schema has carried both
fields since day one, and the client has always rendered `editedText ?? text`. Nothing wrote them.

This decision answers the question the principle leaves open: *where does an overlay live*, now that
users can actually correct a segment.

Two constraints frame it.

- **Ownership.** The `transcripts` table belongs to the transcription worker; the API server reads
  it and has never written it. A correction is a user action arriving over HTTP, so the server is
  the only party that can write one.
- **1:n.** A meeting can have several transcripts (ADR-003 §3). A correction was made against the
  wording of one particular transcript, and reprocessing produces a different one.

## Decision

1. **Corrections are rows in a server-owned table, not fields in the transcript document.** The
   `transcript_corrections` table is keyed by `(tenant_id, transcript_id, segment_id)` and carries
   `edited_text`, `edited_speaker_id` and `updated_at`. The transcript JSON the worker wrote is
   never rewritten — the immutability of ADR-003 is enforced by nobody holding a pen, not by a
   convention about which fields to touch.
2. **A row exists only where a correction exists.** Resetting a segment deletes its row, which is
   what makes "the original is always recoverable" a property of the storage rather than a promise
   in the UI. A correction that equals the machine output is not a correction and stores no row.
3. **The overlay is applied on read.** `GET /api/meetings/:id` merges the rows into the segments of
   the active transcript, so `editedText` and `editedSpeakerId` mean exactly what the schema always
   said they mean and every existing reader keeps working. The table is the single source of truth
   for those two fields: a segment with no row reads as uncorrected, whatever the stored document
   happens to contain.
4. **A correction belongs to one transcript, not to the meeting.** Keying on `transcript_id` means a
   reprocessed meeting starts uncorrected rather than inheriting corrections onto text that may no
   longer say the same thing. Carrying corrections across a reprocessing is the known open problem
   ADR-003 names; this key is what leaves it solvable.
5. **The write endpoints are per segment.** `PUT` sets a segment's overlay in full and `DELETE`
   clears it. Both fields are always present in the request body: an absent field is a malformed
   request, never "leave that one alone", so no client can clear a speaker override by forgetting
   to mention it.
6. **Scope is in the predicate (ADR-001).** Tenant and user come from the access token and are part
   of every statement. A segment of another tenant's meeting matches no row and answers 404 — never
   403, which would confirm that the id exists.
7. **The deletion cascade takes the corrections with it.** They are personal data about a meeting,
   and a meeting deletion is complete or it is not one.

## Why Not the Other Options

**Writing `editedText` into the transcript JSON.** One row, no join, and the client contract is the
same. It is rejected because the server would then be a writer of the worker's document: an
overlapping write with a reprocessing job silently loses either the correction or the new transcript,
and the "immutable machine output" of ADR-003 would rest on both packages remembering which keys
they may touch.

**A single overlay document per transcript.** Fewer rows, but concurrent edits to two segments
become a read-modify-write race, and the cheapest useful question — *when was this transcript last
corrected* — turns into parsing a blob.

## Staleness, Not Reprocessing

A correction after a summary was written makes that summary older than the transcript it describes.
The meeting detail response therefore carries `transcriptCorrectedAt`, the newest correction time
for the active transcript, and the summary view compares it against the summary's `createdAt` to
show an unobtrusive note.

The note is all that is decided here. Whether a corrected transcript should be re-summarized, and
whether the summary pipeline should read the overlay at all, is left open on purpose: the summary
worker reads its own tables today, and giving it a second source is a change to the pipeline, not to
the correction UI.

## Consequences

- The server owns a second table, and the ownership note in `server/src/meetings/schema.ts` says so.
- A reprocessed meeting loses the corrections made against the previous transcript. They are not
  deleted — the rows stay keyed to the transcript they were made against — but nothing shows them.
  That is the honest state until a mapping strategy exists.
- Every future overlay on machine output (redaction masks, highlights) has a shape to follow rather
  than a new decision to make.
