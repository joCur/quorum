# @quorum/e2e

End-to-end suite for Quorum's critical paths. Playwright drives a real browser against the real
compose stack — Postgres, Keycloak, MinIO, the API, the transcription worker — and checks what
landed in object storage and in the database, not only what the UI says.

## The rule

**Any change that touches one of the four critical paths in `CLAUDE.md` extends this suite.**

1. Recording → chunk streaming → persistence → transcript → summary
2. Auth flows (login, token refresh, tenant scope)
3. Deleting a meeting completely (audio, transcripts, summaries, jobs)
4. Crash recovery: reconnect from `persistedSeq`, the local buffer

A path without a test here is a path nobody is watching. Extending the suite is part of the change
that touches the path, not a follow-up.

## Running it

```bash
pnpm run e2e             # from the repository root — brings the stack up, runs, tears it down
pnpm run e2e auth        # the same, limited to specs matching "auth"
```

One command owns the whole run: `docker compose up`, the worker, the built PWA, Playwright, and
the teardown. The suite never reads your `.env`, so a run behaves the same on a laptop and on a
runner. Requirements are Docker and the repository's usual toolchain; the browser is installed on
first run.

Two files appear on the first run, both gitignored — nothing env-shaped is tracked in this
repository:

- `e2e/e2e.env` — a copy of the committed `e2e/e2e.env.example`. Change a port here when it
  collides with something on your machine; the change stays local.
- `e2e/.stack.env` — the generated passwords and storage encryption key. A test stack needs no
  fixed credentials, and committing throwaway ones only teaches everyone to wave secret scanners
  through. Delete the file to roll them; the stack is recreated with the new ones next run.

The Keycloak sign-in credentials are the opposite case: `dev.alice` and friends are documented
fixtures of the committed realm (`infra/keycloak/README.md`), and the suite reads them from there
rather than inventing its own.

The stack runs as its own compose project (`quorum-e2e`) on its own ports, so it does not collide
with a development stack.

| Variable            | Effect                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| `E2E_WHISPER=real`  | Use CPU Whisper (`tiny`) instead of the mock transcription endpoint       |
| `E2E_KEEP_STACK=1`  | Leave the stack running afterwards, for poking at it                     |
| `E2E_REUSE_STACK=1` | Assume the stack is already up and skip `compose up` — the fast inner loop |

Debugging a failure: `E2E_KEEP_STACK=1 pnpm run e2e`, then read
`e2e/playwright-report/`, or open a trace with
`pnpm --filter @quorum/e2e exec playwright show-trace e2e/test-results/<test>/trace.zip`.

### Transcription and summaries: mocked by default

Both backends the worker talks to are OpenAI-compatible HTTP endpoints (ADR-005), and both are
served by `scripts/mock-whisper.mjs` during a run. For transcription this is a deliberate
trade-off, not a shortcut:

- Chromium's synthetic microphone produces a **tone, not speech**, so no assertion can depend on
  the transcript text — with a real model too, the text is noise.
- What the core-path test verifies is the wiring: audio arrives complete in object storage, the
  session is finalized, a `transcribe` job reaches the queue, and the worker writes a correctly
  scoped transcript row. The stub exercises all of it.
- Real CPU Whisper spends minutes downloading and loading a model to produce that noise, which is
  most of a CI budget for no additional signal.

`E2E_WHISPER=real` starts the CPU Whisper container with the smallest model and points the worker
at it. That variant is what to run after touching the worker's transcription client, the response
mapping, or the audio format — it is the only way to find out that a real backend still accepts
what the recorder produces.

Summaries have no real variant: the stack ships no LLM, and pointing the suite at a hosted one
would make every run depend on someone's API key and network. The stub answers with the section
ids the prompt asked for, which is exactly what the mapping keys on, so the assertion is that the
summary is produced, stored and scoped — never what it says.

CI runs the mocked variant on every pull request.

### macOS

Nothing extra: the suite always uses the CPU Whisper image, which is exactly the path the root
`README.md` recommends for integration and end-to-end work on a Mac. The GPU override is
meaningless in Docker on macOS and the suite never uses it. On Apple silicon everything in the
stack is multi-arch, so no Rosetta emulation is involved.

The one macOS-specific note is ports: the defaults deliberately avoid 5432, 8080 and 9000, which
are the ones most likely to be taken already.

## Layout

```
e2e/
  playwright.config.ts    one Chromium project, serial, fake microphone
  fixtures.ts             sign-in, the record controls, the WebSocket watcher, polling helpers
  e2e.env.example         template for the stack configuration; the working copy is gitignored
  docker-compose.e2e.yml  compose override: published ports plus CPU Whisper
  scripts/run.mjs         the orchestrator behind `pnpm run e2e`
  scripts/mock-whisper.mjs  stub transcription and summary endpoints
  support/env.ts          where the stack is reachable, and the dev users
  support/keycloak.ts     tokens outside the browser (password grant, dev-only client)
  support/storage.ts      MinIO assertions — chunk continuity, manifests
  support/database.ts     queue and transcript queries
  support/stack.ts        stopping and starting the API, for the crash test
  support/recording-socket.ts  a protocol-level WebSocket client
  tests/                  one spec per critical path
```

### Adding a path

Write a spec in `tests/`. Sign in with the `signIn` fixture, drive the UI with the `startRecording`
/ `stopRecording` helpers, and get the session id from `watchRecordingProtocol` — it reads
`session.ready` off the wire, because the id never appears in the DOM. Then assert against
`support/storage.ts` and `support/database.ts` rather than against the screen: the screen is the
claim, those two are the evidence.

Specs share one stack and run serially. A spec that breaks the stack on purpose puts it back in an
`afterAll`.

**There are no retries, locally or in CI, and a flaky test fails the run** (`failOnFlakyTests`).
Green has to mean every test passed on its first attempt, or the suite stops being evidence: a
retry that turns red into green hides exactly the races these tests exist to catch. So wait on the
state that actually settles the question, never on a timer — and prefer the signal the system
itself emits. The deletion spec is the worked example: the endpoint removes the audio first and the
database rows second, so "the audio is gone" is true in a window where the rows still exist, and
only the read API answering 404 means both steps are done.

## What the specs cover

| Spec                       | Critical path  | What it proves                                                                                                                       |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `auth.spec.ts`             | Auth flows     | Sign-in through Keycloak's own form; the protected view renders; the token carries the tenant claim and the API agrees; no token means 401; a second tenant cannot address the first tenant's session |
| `recording.spec.ts`        | The core path  | Consent → capture → stop; every chunk in object storage under the right tenant/user prefix with no gap; manifest consistent; `transcribe` job queued; transcript row written and scoped; the summary derived from it stored and scoped |
| `crash-recovery.spec.ts`   | Crash recovery | The API is killed mid-recording: the banner names the buffered duration, capture keeps running, and after the restart the stored sequence is gap-free and duplicate-free |
| `deletion-cascade.spec.ts` | Deletion       | A recorded meeting with a transcript and a summary is deleted through the list's delete flow: no audio left under the session prefix, no transcript, summary or job rows — pg-boss's own queue rows included — the meeting gone from the read API, another tenant refused, and a repeat delete still a 404 |

## Reading the log

`[vite] ws proxy error: ECONNREFUSED` lines during the run are expected: the crash-recovery spec
stops the API on purpose, and the app reconnecting through the preview proxy while it is down is
the behavior under test. They appear between that spec's start and the API coming back.

## Known concessions

- **The worker and the PWA run on the host**, not in containers: the worker has no image yet, and
  building the PWA in the run is what points it at this stack's API and issuer without a second set
  of committed configuration.
- **Summary content is not asserted**, only the chain and the scoping — see above.
- **The PWA is served through a proxy, not next to the API.** A deployment puts one reverse proxy
  in front of both, so the app makes same-origin requests and no CORS is involved. `vite preview`
  reproduces that with `QUORUM_PREVIEW_API_TARGET`; pointing the app at a different origin instead
  would test a shape the product does not ship.
