# ADR-008: The Worker Provisions Its Model Through an Optional Model-Management API

**Status:** Accepted · **Date:** 2026-09-01

> Supplements ADR-005, which put transcription behind an OpenAI-compatible endpoint, and ADR-006 §6,
> which chose the serving image. Those two made the base URL the only thing that varies between
> backends. This ADR records what the worker is now allowed to assume beyond the transcription call
> itself, what it does when the assumption does not hold, and what that means for the serving
> wrapper ADR-006 still plans to build.

## Context

ADR-005 is a promise about substitutability: the worker knows a base URL and a model name, and
swapping `speaches` for a whisperX wrapper, for whisper.cpp on a developer's Mac, or for a hosted
endpoint is a configuration change. That promise held for as long as the worker only ever posted
audio to one route.

It stopped holding at deployment time, for a reason that is a property of the model family rather
than of one image. Backends built on faster-whisper separate two things that sound like one:
**loading** a model into memory is automatic and happens on demand, while **downloading** it to disk
is explicit and happens only when asked. A model that was never downloaded is answered with a
terminal 404, which the job taxonomy classifies as non-retryable — so a fresh deployment recorded
audio happily, dead-lettered the first transcription, and told nobody until a user asked where their
transcript was. The operator's only remedy was a manual API call documented in the deployment guide,
which is a step that gets skipped precisely because nothing fails until much later.

Automating that download is worth doing, and it cannot be done inside the surface ADR-005 named.
`GET /v1/models` is part of the OpenAI-compatible API and is safe to assume. `POST /v1/models/{id}`,
which downloads a model, and the `GET /v1/registry` listing used to tell an operator which IDs are
valid, are the current backend's own extensions. Calling them from worker startup means the worker
now knows something about *which* backend it is talking to — exactly what ADR-005 set out to avoid.

The tension is not hypothetical. ADR-006 §6 plans to replace `speaches` with a serving wrapper of our
own around whisperX. A wrapper that implements exactly what ADR-005 requires would satisfy the
contract and still leave the worker unable to tell a fresh model volume from a broken one.

## Decision

**The worker uses the model-management surface when the backend offers it, degrades in a defined way
when it does not, and never makes it a precondition for transcription.**

Startup, in order: read the model listing, install the configured model if it is absent, verify, and
only then consume jobs. The rungs below describe what happens at each step when the backend answers
something other than the happy case.

### The contract, in three tiers

| Route                          | Tier      | What the worker does without it                                            |
| ------------------------------ | --------- | -------------------------------------------------------------------------- |
| `POST /v1/audio/transcriptions` | Required  | Nothing works. This is ADR-005 and it is unchanged.                        |
| `GET /v1/models` (OpenAI list shape) | Expected | Provisioning is skipped after a bounded probe window, with a warning naming the opt-out. |
| `POST /v1/models/{id}`         | Optional  | Only reached when the model is absent; a backend that serves a fixed set never gets asked. |
| `GET /v1/registry`             | Advisory  | Never called. It appears only as a URL inside the error message for an unknown model ID.  |

### How it degrades

- **The listing shows the model.** One request, no download, and this is what every restart looks
  like once the model volume is warm.
- **The listing does not show the model.** The worker downloads it, verifies it, and starts. A model
  ID the backend does not know is a configuration error, so it fails at startup naming the ID rather
  than at somebody's first recording.
- **The listing is unreachable.** Retried until the configured budget, because the worker and the
  backend start together and "connection refused" is the normal first answer, not a fault.
- **The listing route does not exist.** Concluded only after the same answer has persisted across a
  confirmation window, never from a single response: a reverse proxy whose upstream is not registered
  yet, and a base URL missing its `/v1`, both answer 404 at exactly the moment a worker starts. Once
  confirmed, provisioning is skipped with a warning that names the flag which turns it off for good.
- **The credentials are refused.** Terminal immediately. An authorization failure is a deterministic
  configuration error and no amount of waiting changes it.

### The escape hatch

`WHISPER_MODEL_AUTO_INSTALL=false` removes the whole step, for a backend that bakes its models in or
an operator who manages the cache themselves. It is a single line, and the warning printed on the
degraded paths names it, so nobody has to find this document to get out of the behavior.

## Consequences

- **The whisperX wrapper of ADR-006 §6 gains one spec item:** it must answer `GET /v1/models` with
  the OpenAI list shape, listing what it actually serves. It does *not* need the download route — a
  wrapper whose models are baked into the image should list them and stop there, and the worker will
  find the configured model present and carry on. Without that route the wrapper still works, at the
  cost of a bounded delay on every start and a warning in the log.
- **ADR-005's promise is narrowed, honestly.** Swapping the transcription backend remains a
  configuration change. For a backend without a model listing it is now a configuration change plus
  one more line. That is a smaller claim than the one ADR-005 made, and stating it here is preferable
  to letting the code quietly mean it.
- **The worker takes a startup dependency on the transcription backend.** It will not consume jobs —
  including summary jobs — until provisioning resolves. This is deliberate: summaries exist only
  downstream of transcripts, so a worker that cannot transcribe has nothing to summarize, and one
  loud startup failure is worth more than a dead-lettered job per user. The dependency is bounded by
  configuration, and the health endpoint answers throughout, so a long first download does not read
  as an unhealthy container.
- **Detecting "this backend has no model listing" is heuristic, and we should say so.** The
  confirmation window trades a slower start for a much rarer wrong conclusion, because the failure it
  guards against — silently deciding that an unreachable backend needs no provisioning — recreates
  the exact hole this ADR exists to close. If that window ever proves too short for a real proxy, it
  is a constant to raise, not a design to revisit.
- **This ADR does not supersede ADR-005 or ADR-006.** It records an extension both of them left
  unspecified. A future backend that makes the model-management surface standard, or one that removes
  the download/load split entirely, would make the whole mechanism dead code — and removing it should
  then be a one-line configuration default, not an excavation.
