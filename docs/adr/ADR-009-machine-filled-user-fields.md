# ADR-009: Machine Output May Fill an Empty User-Owned Field

**Status:** Accepted · **Date:** 2026-09-01

## Context

ADR-003 §2 settles what machine output may do to what a person wrote: nothing. Transcript text is
immutable and user corrections sit beside it as an overlay. That rule was written for fields the
pipeline owns and the user annotates.

The meeting title is the other direction. It is a field the *user* owns — the recording screen
offers it, and a rename endpoint writes it — and most recordings arrive without one, because
naming a meeting before it has happened is work nobody wants to do. The summary pipeline reads the
whole transcript anyway, so it can propose a name at no extra cost. The question this decision
answers is whether it may write one, and who writes it.

A second constraint comes from the schema split: `meetings` is owned by the API server and
`transcripts`, `summaries`, `summary_templates` and `jobs` are owned by the worker. Each side reads
the other's tables and, until now, wrote only its own.

## Decision

1. **Machine output may fill an empty user-owned field, once, and may never overwrite one.** A
   suggestion is offered only when the field is unnamed or blank. A value a person typed always
   wins, and a value an earlier run suggested is not replaced by a later run's — regenerating a
   summary must not rename a meeting somebody has been looking at.
2. **The rule is a pure function in `shared/src/`, not a `WHERE` clause.** Every writer and every
   test reads the same decision (`meeting-title.ts`), and "the user has not named this" means the
   same thing in the protocol, in both stores and in the worker.
3. **Filling is not a substitute for correcting.** A field a machine may fill needs a way for its
   owner to change it, shipped with it. For the title that is the rename endpoint; clearing the
   field returns the meeting to unnamed, and the next run may fill it again.
4. **The suggestion is recorded on the machine artifact as well.** The summary document stores the
   title it proposed, whether or not the meeting took it, so what the model produced stays
   auditable even when the user's own name is what is on screen.
5. **The worker writes exactly this one column of `meetings`, in the transaction that writes the
   summary.** The narrow exception to the ownership split is bounded to `meetings.title`: one
   column, only when empty, never an insert and never a delete.

## Why the Worker, and Why in the Same Transaction

Deriving a display title from the active summary at read time would avoid the cross-owner write
entirely, but it would leave the meeting list's title search reading a column that no longer holds
what the list shows. Storing the value is what keeps search, sort and display looking at one
string.

The write shares the summary's transaction because the meeting's state turns "ready" the moment the
summary row exists, and clients stop polling on that. A title committed one transaction later can
miss the last read a screen ever performs, leaving a meeting titled "Untitled" until someone
reloads by hand. Sharing the transaction means a reader that can see the summary can see the name
it produced. The meeting row is locked `FOR UPDATE` at the start of that transaction rather than
upgraded from a shared lock later, so all writers take the same lock in the same order.

## Deliberately Not Now

No `title_source` column, and no generated-versus-user flag. The "fill only when empty" rule
already protects a user's title, and a flag would be a second fact about the same column that every
writer would have to keep true.

## Consequences

- The ownership note in both `schema.ts` files names this exception; the split otherwise stands.
- A generated title is not silently refreshed when a better summary is produced later. That is the
  intended trade: a name that changes under the reader is worse than a name that is merely old.
- Any future field a machine may fill — a meeting's participants, its tags — inherits this shape:
  fill when empty, never overwrite, ship the correction with it.
