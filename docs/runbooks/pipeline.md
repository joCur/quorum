# Runbook — the recording pipeline

What to do when the pipeline misbehaves. Every alert in `infra/monitoring/rules/quorum.yml`
points at a section here, so an alert never arrives without an instruction.

The signals this runbook reads are documented in [`../observability.md`](../observability.md).

## Starting the monitoring stack

It is opt-in — a plain `docker compose up` does not start it:

```bash
docker compose --profile monitoring up -d
```

| Service      | Local URL               | What it is for                                  |
| ------------ | ----------------------- | ----------------------------------------------- |
| Prometheus   | <http://localhost:9090> | Ad-hoc queries, and `/alerts` for rule state     |
| Alertmanager | <http://localhost:9093> | Which alerts are firing, silences                |
| Grafana      | <http://localhost:3001> | The "Quorum — recording pipeline" dashboard      |

Grafana's data source and dashboard are provisioned from `infra/monitoring/`. Edits made in the
browser are lost when the container is recreated — change the files instead.

Alertmanager ships with no real receiver. Routing alerts somewhere means choosing a destination
and holding a credential, which is a deployment decision; until one is configured, alerts appear
in the two UIs above and nowhere else.

## Retry and dead-letter semantics

Both job types run under the same queue policy — `WORKER_RETRY_LIMIT` attempts (default 4) with
exponential backoff from `WORKER_RETRY_DELAY_SECONDS` (default 30 s), and a per-attempt wall-clock
budget of `WORKER_JOB_EXPIRE_SECONDS` (default 2 h). What differs is which failures are allowed to
consume that budget.

A failure is either **transient** (retried) or **terminal** (dead-lettered on the first attempt,
without burning retries, because repeating it cannot change the outcome).

### `transcribe`

Consumed from the `transcribe` queue; failures land on `transcribe-dead-letter`.

"Retried" is what the worker does by itself, with nothing changed. "User retry" is what the
meeting screen offers a person who is saying that something has changed since — the two differ on
purpose, and the section below the summary table explains where and why.

| Code                             | Retried | User retry | Why                                            |
| -------------------------------- | ------- | ---------- | ---------------------------------------------- |
| `TRANSCRIPTION_UNAVAILABLE`      | yes     | yes        | Backend booting, overloaded, 5xx, 429, timeout |
| `AUDIO_FETCH_FAILED`             | yes     | yes        | Object storage hiccup                          |
| `TRANSCRIPT_PERSIST_FAILED`      | yes     | yes        | Database blip                                  |
| `INTERNAL_ERROR`                 | yes     | yes        | Unclassified — assumed transient                |
| `TRANSCRIPTION_REJECTED`         | no      | yes        | Model not installed or misnamed, 401/403        |
| `TRANSCRIPTION_RESPONSE_INVALID` | no      | yes        | Backend answered in a shape we do not accept    |
| `MANIFEST_NOT_FOUND`             | no      | no         | The session was never finalized                 |
| `AUDIO_EMPTY`                    | no      | no         | Nothing was recorded                            |
| `AUDIO_DECODE_FAILED`            | no      | no         | The backend refused these bytes (400/415/422)   |
| `AUDIO_TOO_LARGE`                | no      | no         | The recording exceeds what the backend takes (413) |
| `TRANSCRIPT_INVALID`             | no      | no         | Result fails the schema                         |
| `JOB_PAYLOAD_INVALID`            | no      | no         | The queued payload is not one we understand     |

The retry budget exists mainly for a Whisper container that is slow to load a model.

`TRANSCRIPTION_REJECTED` is almost always the model, not the audio: Whisper
serves only models it has downloaded, and answers `404 Model '…' is not installed locally` for a
model that was never installed or for a short name where a full ID belongs
(`Systran/faster-whisper-small`, not `small`). The worker installs its configured model on startup
and refuses to consume jobs without it, so reaching this code means either that provisioning was
turned off (`WHISPER_MODEL_AUTO_INSTALL=false`) or that the model left the volume while the worker
kept running. Read the worker's `whisper.model.*` startup lines;
[the transcription model](../deployment.md#6-the-transcription-model) lists the valid IDs and the
verify call. The fix is to restart the worker so it provisions again — or to install the model by
hand where provisioning is off — and then redrive what dead-lettered.

### `summarize`

Consumed from the `summarize` queue; failures land on `summarize-dead-letter`.

| Code                        | Retried | Why                                             |
| --------------------------- | ------- | ----------------------------------------------- |
| `SUMMARY_UNAVAILABLE`       | yes     | Backend 5xx, rate limit, timeout                 |
| `SUMMARY_PERSIST_FAILED`    | yes     | Database blip                                    |
| `INTERNAL_ERROR`            | yes     | Unclassified                                     |
| `TRANSCRIPT_NOT_FOUND`      | no      | Nothing to summarize                             |
| `TRANSCRIPT_EMPTY`          | no      | No usable text                                   |
| `SUMMARY_TEMPLATE_NOT_FOUND`| no      | The named template is not stored                 |
| `SUMMARY_REJECTED`          | no      | Rejected request, including an oversized prompt   |
| `SUMMARY_RESPONSE_INVALID`  | no      | Unparseable even after the repair turn            |
| `SUMMARY_INVALID`           | no      | Result fails the schema                          |

The cost profile is inverted from transcription: a transcription retry spends local GPU time, a
summary retry spends money. So the budget covers backend outages and rate limits only — anything
the model itself got wrong is terminal on the first try, because paying four times for the same
wrong answer helps nobody.

No "User retry" column here, because there is no user retry: a summary of an existing transcript
is asked for through Regenerate, which is the same request with a template chosen. Such a column
would have to answer a cost question — replaying an oversized prompt buys the same answer again —
and answering it before anything consumes the answer would only be a guess.

### The user's own retry

A dead-lettered transcription is no longer an operator-only problem. The meeting screen offers
"Try again" on a failed transcription, and `POST /api/meetings/:meetingId/transcription/retry`
puts that same job back on the `transcribe` queue with a fresh budget — the replay the redrive
below performs, narrowed to one job and scoped to the person who owns the meeting.

**What is offered.** The "User retry" columns above are the whole rule, and the rule behind them
is what the failure is about. A failure about the recording or the payload — nothing was recorded,
no decoder takes these bytes, the audio is larger than the backend accepts, the session was never
finalized — is permanent by nature, because the input does not change. Everything else is about
the machinery around it, and machinery is what changes between two attempts. That is why the two
columns differ on `TRANSCRIPTION_REJECTED` and `TRANSCRIPTION_RESPONSE_INVALID`: the worker will
not repeat them now, with nothing changed, but a person pressing the button after you installed
the missing model is telling us something has. The split lives in `isRetryableJobErrorCode`
(`shared/src/job.ts`); a code given a new verdict wants a look at `worker/src/errors.ts` and at
this table too.

**What stops a second run.** A job row saying `failed` does **not** mean nobody is running the
job: the worker writes that row on every attempt, including the ones pg-boss is still going to
repeat after its backoff. And `singletonKey` deduplicates nothing — both queues run under
pg-boss's `standard` policy, which none of the unique indexes behind that key applies to. So the
retry decides against the queue rather than against the row: inside the transaction that moves the
row, it refuses when `pgboss.job` still holds an entry for that job id in a state below
`completed`. The same check reads the opposite case for free — a `queued` row with no entry behind
it is stranded, not busy, and is handed back rather than left waiting for ever.

The row move and the queue insert are one step, so neither can happen without the other, and an
accepted retry also deletes the job's parked entry on `transcribe-dead-letter` — otherwise the
next bulk redrive below would replay a job the user has already had run again.

While the retry is queued or running, the meeting reports `queued`/`transcribing` rather than the
state its previous run left behind: a reprocessing job is visible in the app even on a meeting
that already has a transcript and a summary. A `queued` or `running` row is believed for six
hours; past that it is treated as the leftover of a worker that died mid-job, so a stuck row
cannot tell a finished meeting for ever that it is still being worked on.

### Idempotency — which jobs are safe to replay

All of them, and this is what makes redrive a safe operation rather than a risky one.

- **`transcribe`** derives its transcript id from the job id. A replay that re-transcribes an
  already-transcribed recording writes to the same row and reports `created: false`. It costs GPU
  time, not correctness.
- **`summarize`** derives its job id from the transcript and the template, and the enqueue uses
  that as a pg-boss singleton key, so a replayed transcribe job cannot buy a second model call.
  A user-requested regenerate deliberately mints a fresh id — that is the one case where a second
  call is the point.
- **Chunk writes** during recording are idempotent on the sequence number, which is what lets a
  reconnecting client re-send everything after `persistedSeq`.
- **A deleted meeting** is not a failure. A job that was already running when the meeting was
  deleted abandons its result and completes quietly (`event: job.abandoned`, metric outcome
  `abandoned`). It writes nothing — not the artifact, not a job row — because the deletion cascade
  already removed that meeting's job rows and re-creating one would resurrect the residue the
  cascade erased.

## Redriving the dead-letter queue

Dead-lettered jobs sit on `transcribe-dead-letter` / `summarize-dead-letter`. Nothing consumes
those queues: they exist to be inspected and, once the cause is fixed, replayed.

**1. See what is there.** From a `psql` on the stack database:

```sql
SELECT id, name, created_on, output->>'code' AS code, output->>'message' AS message
  FROM pgboss.job
 WHERE name LIKE '%-dead-letter'
 ORDER BY created_on DESC
 LIMIT 50;
```

**2. Fix the cause first.** The `code` column tells you which. A dead-lettered job is terminal by
definition, so replaying it before the cause is fixed just dead-letters it again — `AUDIO_EMPTY`
will never succeed no matter how often it runs.

**3. Confirm what the replay will cost.** Every job is idempotent (above), so a replay cannot
corrupt anything. It can cost real money on `summarize` and real GPU minutes on `transcribe`, so
count the rows before replaying a large batch.

**4. Redrive.** pg-boss ships the operation. It works on a whole dead-letter queue, oldest first,
not on a single job id — so `limit` is how you control the blast radius. From a Node shell with
the project's dependencies:

```js
import { PgBoss } from "pg-boss";
const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
await boss.start();

// Replay the single oldest one first, to confirm the fix worked:
const moved = await boss.redrive("transcribe-dead-letter", { limit: 1 });
console.log(`${moved} job(s) moved back onto their source queue`);

// Once that job succeeds, drain the rest:
// await boss.redrive("transcribe-dead-letter");

await boss.stop();
```

Each job returns to the queue it came from with a fresh retry budget, and the worker picks it up on
its next fetch. Replay one before draining the batch: it is the cheapest possible confirmation that
the cause is actually fixed.

**5. Confirm.** Watch `quorum_queue_jobs{queue="transcribe",state="active"}` move and the job's
`event: job.succeeded` line appear, correlated by its `jobId`.

If a job should *not* be replayed — the recording is genuinely unusable — delete that row from
`pgboss.job` before draining the rest, so the redrive skips it. The user-facing meeting keeps its
failed job status, which is the honest outcome.

## A job is stuck in `queued`

Alerts: `QuorumJobStuckInQueue`, `QuorumNothingConsumingQueue`.

This is the scenario the whole observability setup exists for: someone is waiting on a transcript
that is never going to arrive on its own.

**1. Read the shape of the queue.** In Prometheus:

```promql
sum by (queue, state) (quorum_queue_jobs)
sum by (queue) (quorum_jobs_in_flight)
```

| What you see                              | What it means                                  |
| ----------------------------------------- | ---------------------------------------------- |
| `created` > 0, nothing `active`, in-flight 0 | Nothing is consuming — go to step 2            |
| `active` > 0, in-flight at the concurrency limit | Saturated or one attempt hangs — see [an attempt runs forever](#an-attempt-runs-forever) |
| `retry` climbing                           | A backend is flapping — see [a backend is failing attempts](#a-backend-is-failing-attempts) |
| `failed` climbing                          | Attempts are exhausting retries — same section  |

**2. Is the worker alive?**

```bash
docker compose ps worker
docker compose logs --tail=100 worker
```

Look for `event: worker.started`. If the process is up but that line never appeared, it failed
before it began consuming — almost always configuration (`DATABASE_URL`, `S3_*`, `SUMMARY_*`) and
the startup error says which.

One case looks like a hang rather than an error: the worker provisions its transcription model
before it consumes anything, so a first start on an empty model volume sits on
`whisper.model.install-started` and repeats `whisper.model.install-progress` until the download is
done — minutes for `large-v3`. `whisper.model.provisioning-failed` is the opposite: that one is
terminal and names the reason, usually a `WHISPER_MODEL` that is not a real model ID. See
[the transcription model](../deployment.md#6-the-transcription-model).

A download that instead fails at almost exactly five minutes, over and over, whatever
`WHISPER_MODEL_INSTALL_TIMEOUT_MS` says, is the transport cap described under transcription below:
a build older than the one that gave the download its own header timeout cannot install a model
big enough to take longer than that. Upgrade the worker — no configuration change lifts it.

If the container is restarting in a loop, the worker healthcheck is what surfaced it; the logs
before each restart carry the reason.

**3. Is it consuming the right queue?** A job enqueued under a name no worker subscribes to waits
forever and looks identical to a dead worker:

```sql
SELECT DISTINCT name FROM pgboss.job WHERE state = 'created';
```

Expect only `transcribe` and `summarize`.

**4. Restart the worker.** `docker compose restart worker`. Jobs are idempotent, so nothing is lost
by doing this, and a graceful stop lets running attempts finish.

**5. Find the affected user.** Every waiting job carries its scope. Take the `jobId` from the query
in the redrive section and search the API logs for that `meetingId` — the `session.finalized` line
gives you the session, tenant and user behind it.

## A backend is failing attempts

Alerts: `QuorumJobFailureRateHigh`, `QuorumJobsDeadLettered`.

**1. Which failure?** Worker logs, filtered to `event: job.failed` — the `code` field is the
answer, and the tables above say whether it is transient or terminal.

**2. Transcription codes** (`TRANSCRIPTION_UNAVAILABLE`, `AUDIO_DECODE_FAILED`, …): check the
`whisper` container. A model still loading produces a burst of `TRANSCRIPTION_UNAVAILABLE` that
resolves itself; a `WHISPER_MODEL` that is misnamed or was never downloaded produces
`TRANSCRIPTION_REJECTED` that never will — verify it against `GET /v1/models` as described in
[the transcription model](../deployment.md#6-the-transcription-model). On builds
older than the one that made `WHISPER_TIMEOUT_MS` reach the HTTP transport, a slow model shows a
distinctive signature instead: every attempt fails after exactly five minutes with
`fetch failed: Headers Timeout Error`, whatever the configured timeout says — upgrade the worker,
because no configuration change lifts that cap.

**3. Summary codes** (`SUMMARY_UNAVAILABLE`, `SUMMARY_REJECTED`, …): check the configured
`SUMMARY_BASE_URL`. `SUMMARY_UNAVAILABLE` in a steady stream is usually a rate limit; sustained
`SUMMARY_REJECTED` is usually an expired key or a model name the provider retired.

**4. After the fix**, redrive whatever dead-lettered in the meantime.

## An attempt runs forever

Alert: `QuorumJobRunningTooLong`.

The worker holds an attempt but has completed nothing on that queue for an hour. Usually a
transcription backend that accepted the request and never answered.

The attempt is not lost: `WORKER_JOB_EXPIRE_SECONDS` (default 2 h) returns it to the queue, and the
work is idempotent. So the choice is to wait it out or to cut it short with
`docker compose restart worker`, which returns the attempt immediately.

If this repeats, the cause is upstream of the worker — check the `whisper` container's own logs
and, on a GPU host, whether the GPU is actually being used. That is the panel DCGM Exporter would
provide (see [`../observability.md`](../observability.md#gpu-utilization)).

## A service is down

Alert: `QuorumTargetDown`.

```bash
docker compose ps
docker compose logs --tail=200 api worker
```

While the **worker** is down nothing is transcribed, but nothing is lost: jobs accumulate in
`created` and drain when it returns. While the **api** is down no new recording can start, and an
in-progress recording buffers in the browser and reconnects from `persistedSeq`.

Note that both queue alerts are suppressed while this one is firing — a down worker makes them
true without making them informative.

## Queue metrics are stale

Alert: `QuorumQueueSnapshotFailing`.

The API could not read pg-boss's tables, so `quorum_queue_jobs` and
`quorum_queue_oldest_pending_age_seconds` are frozen at their last known values. **Treat every
other queue alert as unreliable until this clears** — including their absence.

Almost always the database: check `docker compose ps postgres` and the API logs. This gauge exists
precisely so that "we cannot see the queue" never looks like "the queue is empty".
