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

Three gitignored files appear on the first run — nothing env-shaped is tracked in this repository:

- `e2e/e2e.env` — a copy of the committed `e2e/e2e.env.example`: the stack's non-secret
  configuration. No ports live here; see below.
- `e2e/.stack.env` — the generated passwords and storage encryption key. A test stack needs no
  fixed credentials, and committing throwaway ones only teaches everyone to wave secret scanners
  through. Delete the file to roll them; the stack is recreated with the new ones next run.
- `e2e/.ports.<project>.json` — the host ports a run took, remembered so a reusing run finds the
  same stack. Removed when that stack is torn down.

The Keycloak sign-in credentials are the opposite case: `dev.alice` and friends are documented
fixtures of the committed realm (`infra/keycloak/README.md`), and the suite reads them from there
rather than inventing its own.

| Variable            | Effect                                                                     |
| ------------------- | -------------------------------------------------------------------------- |
| `E2E_WHISPER=real`  | Use CPU Whisper (`tiny`) instead of the mock transcription endpoint         |
| `E2E_KEEP_STACK=1`  | Leave the stack running afterwards, for poking at it                       |
| `E2E_REUSE_STACK=1` | Assume the stack is already up and skip `compose up` — the fast inner loop   |
| `E2E_PROJECT=<name>`| Name this run's compose project instead of letting it generate one          |

Debugging a failure: `E2E_KEEP_STACK=1 pnpm run e2e`, then open a trace with
`pnpm --filter @quorum/e2e exec playwright show-trace e2e/test-results/<project>/<test>/trace.zip`
— the run prints the project name and that path when it starts. In CI the HTML report is under
`e2e/playwright-report/<project>/`.

A stack that never comes up — or that comes up and then refuses the run's setup calls — leaves no
trace and no report, so that failure copies its own evidence out instead: `docker compose ps` and
the containers' logs land in `e2e/test-results/<project>/stack/`, one file for the whole stack plus
one per service that exited badly, written before teardown removes the containers. CI uploads that
directory with the report.

## Isolation: a run owns everything it touches

Two suite runs on one machine — two agents, two worktrees, a rerun started before the last one
finished — must not be able to see each other, and neither must the demo or development stack a
laptop already has up. So a run namespaces both halves of what it occupies.

**Its own compose project.** Every run generates a name (`quorum-e2e-<random>`) and passes it as
`-p`. Teardown is `down -v` against that name, so it can never reach another run's containers or
volumes. Two exceptions, both deliberate, because a stack you intend to find again needs a name
decided in advance:

- `E2E_PROJECT=<name>` names the project yourself.
- `E2E_KEEP_STACK=1` and `E2E_REUSE_STACK=1` fall back to the fixed name `quorum-e2e-keep` — one
  obvious slot per machine for the inner loop, which a run with a generated name never picks by
  accident. Keep one stack (`E2E_KEEP_STACK=1 pnpm run e2e`), then iterate against it
  (`E2E_REUSE_STACK=1 pnpm run e2e recording`). Two _concurrent_ reuse loops need two names; give
  them one with `E2E_PROJECT`.

**Its own ports.** Every host port — the published container ports plus the PWA, the mock backend
and the worker's metrics endpoint on the host — is taken from the free/ephemeral range as the run
starts, held open together so no two land on the same number, and passed to compose through the
environment (which outranks `--env-file`). There is no fixed default left for a demo stack to be
holding. A reusing run reads the ports back out of `e2e/.ports.<project>.json`, because the
containers already publish them.

Pin one when a predictable URL helps — `CLIENT_PORT=4173 pnpm run e2e`. A pinned port that
something else holds still fails the run immediately and names the process holding it, which is
the only honest answer: the alternative is a suite that quietly tests whatever answered.

The PWA's origin is the interesting case. The committed realm lists fixed redirect URIs, and a run
on a free port is not on that list, so the run patches the `quorum-pwa` client in **its own
throwaway Keycloak** to allow the origin it is actually serving from. The shared realm file stays a
description of the product rather than a list of ports.

One thing a run does not isolate is the checkout it builds from: `dist/` is shared, and a second
run rebuilding it would pull the ground out from under the first. Concurrent runs therefore need
separate worktrees — which is how they arise in practice anyway.

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

The stub also answers the model listing the worker checks on startup, claiming the model the run
configures. That keeps the worker's provisioning step on its ordinary path — the model is already
there, nothing is downloaded — instead of pushing it into the fallback for backends that have no
listing at all.

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

Ports are no longer a macOS note either: the run takes free ones, so 5000 and 7000 (AirPlay) and
whatever else a Mac has claimed are simply never picked.

## Layout

```
e2e/
  playwright.config.ts    one Chromium project, serial, fake microphone
  fixtures.ts             sign-in, the record controls, the WebSocket watcher, polling helpers
  e2e.env.example         template for the stack configuration; the working copy is gitignored
  docker-compose.e2e.yml  compose override: the ports the run publishes plus CPU Whisper
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
| `auth.spec.ts`             | Auth flows     | Sign-in through Keycloak's own form; the protected view renders; the token carries the tenant claim and the API agrees; no token means 401; a stale access token is renewed silently and the user never notices; a session with nothing left to renew from lands on sign-in and returns to where it ended; signing out ends the provider's session too; a second tenant cannot address the first tenant's session |
| `registration.spec.ts`     | Auth flows     | Registering through Keycloak's own form, verifying by real mail, opening the link in a second tab the way a mail client does, and arriving with a provisioned tenant that a recording is then written under; a stale callback address is just the sign-in screen |
| `recording.spec.ts`        | The core path  | Consent → capture → stop; the hold that ends it and the short press that must not; pause and resume without splitting the meeting; the microphone the user picked; capture surviving navigation across the app; an online meeting captured as sound only, and the share stopped from the browser. Every chunk in object storage under the right tenant/user prefix with no gap; manifest consistent; `transcribe` job queued; transcript and summary rows written and scoped, and both readable on the meeting screen |
| `templates.spec.ts`        | The core path  | A user's own template shapes a summary; regenerating with it leaves the first summary standing, and deleting the template leaves its summaries standing; a user default is used by a later recording; a template chosen at the start of a recording beats that default; deleting the template that is currently the default hands the mark back to the system one |
| `crash-recovery.spec.ts`   | Crash recovery | The API is killed mid-recording: the banner names the buffered duration, capture keeps running, and after the restart the stored sequence is gap-free and duplicate-free. And the tab itself dies mid-recording while the server is away: the chunks counted in IndexedDB before the crash are offered for recovery afterwards, delivered on one press, and end up as the same gap-free sequence and one meeting |
| `deletion-cascade.spec.ts` | Deletion       | A recorded meeting with a transcript and a summary is deleted through the list's delete flow: no audio left under the session prefix, no transcript, summary or job rows — pg-boss's own queue rows included — the meeting gone from the read API, another tenant refused, and a repeat delete still a 404 |
| `limits.spec.ts`           | All four       | The last hop of a refusal: a recording refused for too many open sessions, and a summary asked for again past its allowance, each arriving on screen as a sentence rather than as a raw code or as silence, and neither leaving the screen pretending the work happened |

## Reading the log

`[vite] ws proxy error: ECONNREFUSED` lines during the run are expected: the crash-recovery spec
stops the API on purpose, and the app reconnecting through the preview proxy while it is down is
the behavior under test. They appear between that spec's start and the API coming back.

## Known concessions

- **The worker and the PWA run on the host**, not in containers: the worker has no image yet, and
  building the PWA in the run is what points it at this stack's API and issuer without a second set
  of committed configuration.
- **Summary content is not asserted**, only the chain and the scoping — see above.
- **Deleting a meeting while a job is still in flight is not driven as a race.** The cascade is
  asserted against a meeting whose transcript and summary already exist, which is the state that
  makes every assertion unambiguous. Winning the race deliberately would mean holding the worker
  mid-job, and a spec that only sometimes hits the window is a flaky spec claiming to be a
  guarantee. The ordering the endpoint relies on — storage first, rows second, a repeat delete
  still a 404 — is asserted directly instead.
- **The three duration limits are not provoked.** Reaching them means four hours of recorded audio,
  twelve hours of open session or a two-hour pause; a spec would have to shrink them in the stack
  configuration, and the numbers it then asserted would not be the numbers the product ships. Both
  limits that a user can reach in ordinary use *are* provoked, against the shipped values, in
  `limits.spec.ts`.
- **The PWA is served through a proxy, not next to the API.** A deployment puts one reverse proxy
  in front of both, so the app makes same-origin requests and no CORS is involved. `vite preview`
  reproduces that with `QUORUM_PREVIEW_API_TARGET`; pointing the app at a different origin instead
  would test a shape the product does not ship.
