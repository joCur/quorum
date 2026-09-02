# Observability — logs and metrics

Async pipelines fail quietly. This document describes the two signals that make a stuck recording
diagnosable without reading code: the structured log schema both services emit, and the Prometheus
metrics they expose.

The alert rules and the monitoring stack that consume these live in `infra/monitoring/`; what to do
when one of them fires is in [`runbooks/pipeline.md`](runbooks/pipeline.md).

Start the monitoring stack — it is opt-in, and no other service depends on it:

```bash
docker compose --profile monitoring up -d
```

## Why Prometheus and not OpenTelemetry

`docs/OPEN-QUESTIONS.md` named "OpenTelemetry + Grafana stack" as a candidate. We took the smaller half
of it deliberately.

The question worth answering is "why has this meeting had no transcript for twenty minutes?", and
answering it needs three things: how many jobs are waiting, how long the oldest one has waited, and
what happened to the attempts that ran. Those are counters and gauges on a scrape endpoint. An
OpenTelemetry setup adds an SDK to both services and a collector process before the first number
appears, and buys distributed tracing — which pays off across many hops, and this pipeline has two.

The exposition format below is what an OTel collector would export to Prometheus anyway, so metric
names stay valid if tracing is added later. That would be an addition, not a rewrite.

Logs stay as they are: JSON on stdout, collected by whatever the deployment already collects with.
No log shipper is prescribed here.

## Log schema

Both services log JSON to stdout via pino, with the same envelope:

| Field     | Always | Meaning                                              |
| --------- | ------ | ---------------------------------------------------- |
| `level`   | yes    | Word, not a number: `info`, `warn`, `error`           |
| `time`    | yes    | ISO-8601 timestamp                                    |
| `service` | yes    | `quorum-server` or `quorum-worker`                    |
| `msg`     | yes    | Human sentence. Never parse it — parse `event`        |
| `event`   | mostly | Stable machine-readable name of what happened         |
| `err`     | on failure | Serialized error, including its `code` where we have one |

`msg` is for a human reading a terminal. `event` is the field queries and alerts match on, and it
is the one that must not change silently.

### Correlation fields

These are what let a single recording be followed from the browser to a finished summary. Every
line emitted while the relevant context is known carries them:

| Field       | Where it comes from                      | Present in                               |
| ----------- | ----------------------------------------- | ---------------------------------------- |
| `tenantId`  | Validated access token (ADR-001)          | Every authenticated request, every job    |
| `userId`    | Validated access token                    | Every authenticated request, every job    |
| `sessionId` | Minted at `session.start`                 | Recording connection, every job           |
| `meetingId` | Minted at `session.start`                 | Recording connection, meeting API, jobs   |
| `jobId`     | Minted at `session.end` / on regenerate   | `session.finalized`, every worker line    |
| `attempt`   | pg-boss retry count                       | Every worker line                         |

The chain that makes diagnosis possible: `session.finalized` on the API side logs the `jobId` next
to the `sessionId` and `meetingId`. Every worker line for that job repeats all four. So one query
on a `meetingId` returns the recording, the finalization, the enqueue, and every transcription and
summary attempt in order.

Correlation is applied through pino child loggers rather than passed argument by argument, so a new
log line inside an existing scope inherits the fields without anyone remembering to add them.

### Events

Server (`quorum-server`):

| `event`                          | Level | Meaning                                                         |
| -------------------------------- | ----- | --------------------------------------------------------------- |
| `auth.rejected`                  | info  | A request arrived without a valid access token                   |
| `session.started`                | info  | A recording session was created and indexed                      |
| `session.reattached`             | info  | A client reconnected and rebuilt its state from object storage    |
| `session.finalized`              | info  | Audio is complete; the transcription job is on the queue          |
| `session.failed`                 | warn  | The connection was closed by a server-side failure                |
| `meeting.index_failed`           | warn  | The meeting row could not be written; recording continued         |
| `meeting.finalize_index_failed`  | warn  | The meeting could not be marked finalized; audio and job are safe |
| `meeting.deleted`                | info  | A meeting and everything derived from it were removed             |
| `meeting.renamed`                | info  | A user set or cleared a meeting's name; `cleared` says which      |
| `limit.session_duration_exceeded` | info | A recording hit the duration cap and was finalized server-side     |
| `limit.parallel_sessions_exceeded` | info | A recording was refused: the user is already at the session cap   |
| `limit.chunk_rate_exceeded`      | info  | A connection was closed for sending chunks too fast               |
| `limit.byte_rate_exceeded`       | info  | A connection was closed for sending bytes too fast                |
| `limit.storage_quota_exceeded`   | info  | A recording was refused: the user's stored audio fills their quota |
| `limit.monthly_hours_quota_exceeded` | info | A recording was refused: the month's recording allowance is spent |
| `quota.read_failed`              | warn  | Quota usage could not be read; the session was allowed to start   |
| `quota.usage_write_failed`       | warn  | Session usage could not be stored; the quota may lag behind       |
| `quota.usage_measure_failed`     | warn  | Stored audio could not be measured; this connection's estimate was used |
| `summary.regenerate_queued`      | info  | A user asked for a new summary of an existing transcript          |

The `limit.*` events are logged at `info`, not `warn`: a limit doing its job is normal operation,
not an incident. They matter because without them a refused recording is invisible on the server —
the user sees a connection that closes and the operator sees nothing. The event name is the same
string the client receives as the close reason, so one search matches both sides.

Worker (`quorum-worker`):

| `event`                     | Level | Meaning                                                         |
| --------------------------- | ----- | --------------------------------------------------------------- |
| `worker.started`            | info  | Process is consuming both queues                                 |
| `job.started`               | info  | An attempt began                                                 |
| `audio.assembled`           | info  | Chunks were fetched and joined                                   |
| `transcription.completed`   | info  | The Whisper backend answered                                     |
| `summary.enqueued`          | info  | The follow-up summary job was placed on the queue                 |
| `summary.enqueue_failed`    | error | Transcript is persisted but the summary job could not be queued   |
| `summary.title.applied`     | info  | Whether the meeting took the name the summary suggested for it    |
| `job.succeeded`             | info  | The artifact is persisted                                        |
| `job.failed`                | error | The attempt failed; see `code` and `retryable`                    |
| `job.settled`               | error | The queue outcome: retried, or moved to the dead-letter queue      |
| `job.abandoned`             | info  | The meeting was deleted mid-run; nothing was written. Not an incident |
| `job.state.persist_failed`  | error | The failure itself could not be recorded in the database          |
| `session.metadata.missing`  | warn  | Session object is gone; the manifest timestamp was used instead    |
| `worker.stopping`           | warn / error | The process is shutting down; `reason` says why. See below |
| `worker.shutdown-failed`    | warn / error | The release did not finish; same split as `worker.stopping` |
| `worker.shutdown-trigger-ignored` | debug / error | A second trigger arrived during a shutdown; `error` when it carried one |

### The worker's exit contract

A queue consumer stops for exactly one legitimate reason: somebody asked it to. That split is the
whole point of `worker.stopping`, and it is visible in three places at once — the level, the
`reason` field and the exit status.

| `reason`                                                                                             | Level | Exit | Meaning                                                        |
| ---------------------------------------------------------------------------------------------------- | ----- | ---- | -------------------------------------------------------------- |
| `signal`                                                                                             | warn  | 0    | `SIGINT`/`SIGTERM`; in-flight jobs are allowed to finish first |
| `startup-failed`, `uncaught-exception`, `unhandled-rejection`, `queue-stopped`, `event-loop-drained` | error | 70   | Nobody asked; the queue is stopped without draining            |

`warn` for the requested case rather than `info` is deliberate: the end-to-end harness runs the
worker at `warn`, and this is the one line that separates "someone stopped it" from "it vanished".
Exit `70` is sysexits `EX_SOFTWARE` rather than a bare `1`, which every unhandled throw already
returns — and above all it is not `0`, because a supervisor reads `0` as "this process was
finished" and a worker never is. `event-loop-drained` is the case worth knowing about: a Node
process whose loop empties exits `0` printing nothing at all, so without this guard a worker that
silently stopped consuming looked exactly like one that had completed its work.

`worker.shutdown-failed` follows the same split. During a `compose down` the database and the
worker are signalled at the same moment, so a pool close that loses its connection is the ordinary
shape of a correct teardown — on a requested stop it is a `warn` and the exit stays `0`. After a
fault it is an `error` and the exit stays `70`.

## Metrics

Both processes expose a Prometheus endpoint on the compose network. Neither is published to a host
port: they carry no tenant data, but they are internal surfaces and belong behind the reverse proxy.

| Process | Endpoint                                  |
| ------- | ----------------------------------------- |
| API     | `http://api:8080/metrics`                 |
| Worker  | `http://worker:9091/metrics` (`WORKER_METRICS_PORT`) |

### Queue metrics — exposed by the API

The queue is described by the process that is always running. A crashed worker is exactly the
situation the backlog alert has to survive, so a gauge that dies with the worker cannot carry it.
The API reads pg-boss's own tables on each scrape.

| Metric                                     | Type  | Labels           | Meaning                                                    |
| ------------------------------------------ | ----- | ---------------- | ---------------------------------------------------------- |
| `quorum_queue_jobs`                        | gauge | `queue`, `state` | Jobs per queue and pg-boss state                            |
| `quorum_queue_oldest_pending_age_seconds`  | gauge | `queue`          | Age of the oldest job that is due to run and has not started |
| `quorum_queue_snapshot_failed`             | gauge | —                | `1` when the last queue read failed                          |

`state` is one of `created`, `retry`, `active`, `failed`. `completed` and `cancelled` are not
exposed: pg-boss keeps completed rows for its retention window, so a gauge over them measures
retention rather than health.

The split by state is what turns a number into a diagnosis:

- many `created`, zero `active` — nothing is consuming the queue
- few `created`, `active` pinned at the concurrency limit — the worker is saturated or a job hangs
- `retry` climbing — a backend is flapping and attempts are being redone
- `failed` climbing — attempts are exhausting their retries

`quorum_queue_oldest_pending_age_seconds` only counts jobs whose `start_after` has passed, so a job
serving out its retry backoff is not reported as backlog. That is the metric the stuck-queue alert
is written against.

### Job metrics — exposed by the worker

| Metric                        | Type      | Labels             | Meaning                              |
| ----------------------------- | --------- | ------------------ | ------------------------------------ |
| `quorum_jobs_total`           | counter   | `queue`, `outcome` | Finished attempts                    |
| `quorum_job_duration_seconds` | histogram | `queue`, `outcome` | Attempt duration, dequeue to outcome |
| `quorum_jobs_in_flight`       | gauge     | `queue`            | Attempts running right now           |

`outcome` is one of:

| `outcome`    | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `succeeded`  | The artifact was persisted                                            |
| `failed`     | The attempt failed and will be retried                                |
| `deadletter` | The attempt failed terminally or exhausted its retries                |
| `abandoned`  | The meeting was deleted mid-run; nothing was produced, nothing is wrong |

These are attempt outcomes, not job outcomes: a job that fails twice and then succeeds contributes
two `failed` and one `succeeded`. That is what makes the failure rate meaningful — the ratio says
how much work is being redone, which is the number that moves when a backend starts flapping.

`abandoned` is separate from `succeeded` on purpose, so a bulk deletion does not read as a
throughput spike.

Every `queue`/`outcome` series is pre-seeded at zero. Without that, a queue that has never failed
has no `failed` series at all, and a failure-rate expression over a missing series returns nothing
rather than zero — a silent alert instead of a green one.

### Process metrics

Both registries include the Node defaults under the `quorum_` prefix: heap and resident memory,
event loop lag, active handles, file descriptors, CPU seconds. `quorum_process_cpu_seconds_total`
and `quorum_nodejs_eventloop_lag_seconds` are the two worth a dashboard panel — a worker that is
busy but making no progress shows up in the second one.

### GPU utilization

Not emitted by this codebase, deliberately. Transcription runs in the `whisper` container, not in
the worker, and development machines have no GPU at all; scraping `nvidia-smi` from a container
with no driver mounted would report a confident zero everywhere.

The hook is [DCGM Exporter](https://github.com/NVIDIA/dcgm-exporter) as a sidecar on the GPU host,
scraped by the same Prometheus. It publishes `DCGM_FI_DEV_GPU_UTIL` and `DCGM_FI_DEV_FB_USED` per
device, which is what a "is the GPU the bottleneck?" panel needs. It belongs next to the GPU compose
override and the device reservation it depends on, and needs no code here.

## Adding a metric

Metric names are an ops contract: alert rules and dashboards are written against them, so renaming
one is a breaking change for whoever is on call. Add rather than rename, and update this document
and the alert rules in the same change.
