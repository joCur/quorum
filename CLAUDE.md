# Quorum — Working Process (Team Rules)

## Language policy

- **All code and documentation is written in American English (en-US) — 100%, no exceptions.** No German identifiers, comments, commit messages, ADRs, or issue texts.
- All user-facing strings go through **i18n** — never hard-coded German (or any other language) in code. German is a translation catalog, not a value in source.
- (Chat communication with the PO remains German.)

## Git & PR process

- **NEVER push to main directly, no exceptions.** Every change lands as a pull request. A ruleset enforces this: main accepts only approved, squash-merged pull requests whose required checks are green, and it refuses deletions and non-fast-forward pushes.
- The ruleset also dismisses stale approvals when a branch is pushed, requires the last push to be approved, and requires review threads to be resolved. So a review is not banked: pushing after approval means asking for it again.
- Every ticket runs in its own worktree on a feature branch: `<issue-number>-<slug>` (e.g. `4-websocket-recording-endpoint`).
- Merge ONLY when: **CI green** **+ lead verification** (a click path for UI changes) **+ explicit PO approval on the PR**.
- The branch is deleted automatically on merge. For stacked PRs that means retargeting the dependent PR onto main **before** its base branch disappears — GitHub closes a PR whose base branch is deleted, and a closed PR cannot be reopened.
- Worktrees: symlink every `.env*` file from the repository root into the worktree (they are gitignored, and their absence causes failures that are hard to diagnose).

## Team & roles

- The **lead does not implement** — not even one-liners. The lead scopes tickets, briefs engineers, reviews, verifies, and merges.
- Engineer agents (backend, frontend, infra, QA) run on **Opus**; only the lead runs on Fable. A designer runs on Fable only at the PO's explicit request.
- Roles: backend/pipeline · frontend/PWA · infra/ops · QA/security.

## Tickets

- The roadmap lives as GitHub issues and milestones.
- Every issue: context (which ADRs apply), acceptance criteria, the affected schemas from `shared/src/`.
- Architecture decisions are recorded as an ADR in `docs/adr/` before they are implemented.
- Repository files — code comments, READMEs, ADRs, compose files — must never reference issue or PR
  numbers; describe the subject instead. Issue references belong in PR descriptions and commit
  messages only, because those keep their context once an issue is gone.
- Repository files must not record session history either — no dates, attributions, or notes about
  which account or agent did the work. Those belong in local memory, not in a doc that outlives them.

## Critical paths (E2E required)

Every change touching one of these paths needs an E2E test, extended if one already exists:

1. Recording → chunk streaming → persistence → transcript → summary (the core path)
2. Auth flows (login, token refresh, tenant scope)
3. Complete deletion of a meeting (cascade: audio, transcripts, summaries, jobs)
4. Crash recovery: reconnect from `persistedSeq`, the IndexedDB buffer

## Architecture ground rules

- `shared/src/` (the Zod schemas) is the single source of truth — client and server import from it, never duplicate it.
- Machine output is immutable; user corrections are overlays (ADR-003/004).
- Every long-running operation is a server-side job (the job schema in `shared/src/job.ts`) — never bound to the browser.
- Tenant/user scope in every data object from day one (ADR-001).
