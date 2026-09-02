# ADR-011: Transcript Corrections Live Beside the Transcript, Not Inside It

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
6. **One correction per segment, last writer wins.** The key is `(tenant, transcript, segment)`;
   `user_id` records who wrote the correction and is never part of the key or the predicate. A
   passage reads one way for everyone who can see the meeting, so two people correcting it is a
   conflict settled by order of arrival — not two overlays a reader would have to choose between.
   Per-author overlays would be a different product decision, and it is not this one.
7. **The response says what the store did, not what the request asked for.** The endpoints answer
   from the write's own outcome. A write that did not land is never described as one that did.
8. **A correction is refused when the transcript is no longer the active one.** The active
   transcript is resolved by one statement and written by another, and a reprocessing can land in
   between. The write re-checks `is_active` under a row lock and answers `409 transcript_replaced`
   so the client can say the transcript was replaced instead of showing a correction that is stored
   against a document nothing displays.
9. **Scope is in the predicate (ADR-001).** Tenant and user come from the access token and are part
   of every statement. A segment of another tenant's meeting matches no row and answers 404 — never
   403, which would confirm that the id exists.
10. **The deletion cascade takes the corrections with it.** They are personal data about a meeting,
    and a meeting deletion is complete or it is not one.

## Why Not the Other Options

**Writing `editedText` into the transcript JSON.** One row, no join, and the client contract is the
same. It is rejected because the server would then be a writer of the worker's document: an
overlapping write with a reprocessing job silently loses either the correction or the new transcript,
and the "immutable machine output" of ADR-003 would rest on both packages remembering which keys
they may touch.

**A single overlay document per transcript.** Fewer rows, but concurrent edits to two segments
become a read-modify-write race, and the whole set has to be rewritten to change one word.

## The Summary Note Follows Existence, Not Time

The summary pipeline does not read the overlay. It renders the transcript document, and the
document is the machine's output — so **every summary in this cut is written from the original
wording**, whenever it was written. The meeting screen therefore shows its note whenever the active
transcript carries any correction at all: *the summary is based on the original wording.*

The obvious alternative — compare the newest correction against the summary's `createdAt` — was
implemented first and is wrong in both directions:

- Regenerating a summary would clear the note, although the new summary read the original wording
  exactly like the old one did. The note would disappear precisely when a user tried to act on it.
- Resetting one of several corrections would clear the note, although the remaining ones still make
  the transcript read differently from the summary's source.

Existence is also the cheaper fact: it is on the segments the response already carries, so there is
no `transcriptCorrectedAt` field for every writer to keep true.

The same reasoning forbids the pipeline from honoring the `edited*` fields it finds inside an old
transcript document (§3 makes the rows the only source of truth), and `renderSegment` says so where
it reads `text`. API and pipeline agree on what a transcript says, or the note is a lie.

Whether a corrected transcript should be re-summarized is left open on purpose: giving the summary
worker a second source is a change to the pipeline, not to the correction UI.

## Consequences

- The server owns a second table, and the ownership note in `server/src/meetings/schema.ts` says so.
- A reprocessed meeting loses the corrections made against the previous transcript. They are not
  deleted — the rows stay keyed to the transcript they were made against — but nothing shows them.
  That is the honest state until a mapping strategy exists.
- A correction can be refused with a 409 during the seconds a reprocessing takes. That is a real
  interruption, and it is the right one: the alternative is accepting a correction against a
  transcript nobody will ever see again.
- Every future overlay on machine output (redaction masks, highlights) has a shape to follow rather
  than a new decision to make.
