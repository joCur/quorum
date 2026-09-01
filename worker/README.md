# @quorum/worker

Job worker for the processing pipeline. It consumes two job types from pg-boss:

- **`transcribe`** — enqueued by the recording endpoint on `session.end`. Turns the stored chunks back into an audio file, sends it to an OpenAI-compatible Whisper endpoint and persists the result as an immutable `Transcript` (ADR-003).
- **`summarize`** — enqueued by the transcribe handler itself, once a transcript is persisted. Builds a prompt from a summary template, calls an OpenAI-compatible chat completions endpoint and persists a `Summary` with the resolved template snapshot (ADR-004, ADR-005).

Together they are the core path of the product: recording → transcript → summary, with no step bound to a browser tab.

The worker is a separate process and a separate workspace from the API server: this work is long-running and CPU/GPU/network-bound, and scaling or restarting it must not touch the HTTP surface.

## Container image

`Dockerfile` in this directory builds the production image, but its build context is the **repository root** — the worker consumes the `@quorum/shared` workspace and the root pnpm lockfile:

```bash
docker build -f worker/Dockerfile .      # or: docker compose build worker
```

It mirrors the API image stage for stage: pnpm comes from Corepack with the version pinned in the root `packageManager` field, both workspaces are compiled in a build stage, and the runtime stage carries only production dependencies and runs as the unprivileged `node` user with `NODE_ENV=production`. Unlike the API it exposes no port and declares no health check: a queue consumer has no HTTP surface, its liveness is the pg-boss connection, and a process that loses that connection exits and is restarted by the compose restart policy.

The `worker` service in `docker-compose.yml` runs it against the stack. It waits for Postgres and for the one-shot bucket bootstrap, because the first job it picks up reads chunk objects from that bucket.

**Why both job types live in one workspace.** They are two handlers behind the same queue library, the same job schema, the same error taxonomy, the same database and the same idempotency rules — a second workspace would duplicate all of that to gain a deployment boundary nobody has asked for. The split that would matter is a *process* one (summaries are network-bound and want different concurrency than a GPU-bound transcription), and that is already available without touching the code: `SUMMARY_CONCURRENCY` and `WORKER_CONCURRENCY` are separate, and starting one replica per queue is a wiring change in `src/index.ts`, not an architectural one.

## Transcription pipeline

1. **Payload** — the queue message carries the `Job` from `shared/src/job.ts` plus the tenant, user and session scope (ADR-001). It is validated, never trusted: the two processes deploy independently.
2. **Manifest** — `manifest.json` is read from object storage. It is the contract for what a finalized recording contains: `chunkCount`, `persistedSeq` and the ordered `chunkKeys`. A manifest whose numbers contradict each other fails the job instead of producing audio with a hole in it.
3. **Assembly** — the chunk objects are fetched in parallel and concatenated in sequence order. The recording endpoint stores one object per chunk so that re-sends are idempotent overwrites; a `MediaRecorder` stream is a single container whose chunks are continuation bytes, so ordered concatenation reproduces the original file. Nothing is transcoded here.
4. **Transcription** — one `POST /audio/transcriptions` with `response_format=verbose_json` and `timestamp_granularities[]` of both `segment` and `word`. Word-level timestamps are requested unconditionally: ADR-003 §4 makes them a day-one requirement.
5. **Mapping** — the response becomes a `Transcript`. The mapping is a pure function; see *Idempotency* below for why that matters.
6. **Persistence** — the transcript is stored as JSONB with its queryable metadata in real columns (ADR-006 §4), and the job state is recorded per the shared job schema.

## Transcription backends

The worker only ever knows `WHISPER_BASE_URL` (ADR-005). Anything that speaks the OpenAI transcription API works unchanged:

- `speaches` in the compose stack today,
- the whisperX-based serving wrapper once it exists (ADR-006 §6),
- `whisper.cpp --server` or `mlx-whisper` running natively on a macOS host.

Backends differ in where they put word timestamps. `speaches` attaches `words[]` to each segment; OpenAI returns one flat top-level `words[]` and segments without words. Both are handled — flat words are assigned to segments by midpoint containment, so every word lands in exactly one segment. A backend that returns only `text` yields a single segment spanning the recording rather than a failed job.

`confidence` is derived from the segment's `avg_logprob` via `exp()`, which puts it in the 0..1 range the schema expects. It is a rough quality signal, not a calibrated probability.

`speakers[]` stays empty and every `speakerId` is null until diarization exists (ADR-003 §7). The user-correction overlays `editedText` and `editedSpeakerId` are never written by machine output — that is the whole point of ADR-003 §2.

## Model provisioning

Backends of this family separate two things that sound like one: loading a model into memory is automatic and on demand, downloading it to disk is not. A model that was never downloaded is answered with a terminal 404, so a fresh deployment used to transcribe nothing until an operator installed the model by hand — and the first person to record a meeting was the one who found out.

The worker therefore provisions its own model before it consumes anything (`src/whisper/provision.ts`). It reads `GET /models`, downloads `WHISPER_MODEL` with `POST /models/{id}` when it is missing, verifies the result, and only then subscribes to the queues. It is the natural place for this: the worker is the only component that knows both the base URL and the model name (ADR-005), and it runs identically under the CPU and GPU compose profiles, which differ only in how the backend is scheduled.

What it does in each case:

- **Idempotent.** A restart with the model already in the `whisper-models` volume costs one request and logs `whisper.model.present`. A listing that spells the ID with different capitalization still counts as a match, and says so — re-downloading a model that is already there, on every start, is the alternative.
- **Loud on a deterministic error.** A model ID the backend does not know, or credentials it refuses, fails the startup naming the variable to fix, instead of dead-lettering somebody's recording later. Neither is retried: waiting heals neither a typo nor a wrong token.
- **Patient with a backend that is still starting.** Connection failures and 5xx are retried until `WHISPER_MODEL_INSTALL_TIMEOUT_MS`. The health endpoint is already answering during the download, so a long first start does not read as an unhealthy container.
- **Slow to conclude that a backend has no model management.** A 404 on the listing is what a reverse proxy answers before its upstream route is registered, and what a base URL missing `/v1` answers forever. Deciding "no model management" from one response is how provisioning would switch itself off in the deployments that need it most, so the answer has to persist across a confirmation window before it is believed. Once it is, the step is skipped with a warning naming both likely causes.
- **Careful about calling a download a failure.** Afterwards the listing is polled for a grace period rather than read once, because nothing promises that a finished download and an updated listing happen in the same instant.

`WHISPER_MODEL_AUTO_INSTALL=false` turns the step off entirely, for an operator-managed model cache or a backend that bakes its models in. ADR-008 records the contract underneath all of this: which routes are required, which are optional, and what a minimal compliant backend has to implement.

## macOS development

Docker on macOS has no GPU access, so the CUDA image is meaningless there. Both documented paths work without a code change:

1. **CPU image (full stack parity).** Set `WHISPER_IMAGE_TAG=latest-cpu`, `WHISPER_DEVICE=cpu` and `WHISPER_MODEL=Systran/faster-whisper-small` with int8 in `.env` and start the stack as usual; the worker downloads that model on its first start (see *Model provisioning*). Use a full model ID — `speaches` answers 404 for a short name like `small`. Right for integration and end-to-end tests; slow but faithful.
2. **Host-native Whisper (speed).** Run `whisper.cpp --server` or `mlx-whisper` on the host with Metal, leave the `whisper` container out, and point the worker at it:

   ```bash
   WHISPER_BASE_URL=http://host.docker.internal:8080/v1   # worker in a container
   WHISPER_BASE_URL=http://127.0.0.1:8080/v1              # worker on the host
   ```

   This gives faster-whisper-grade word timings, not whisperX forced alignment — fine for feature work, not for judging alignment quality.

## Summary pipeline

1. **Payload** — `{ job, tenantId, userId, sessionId, transcriptId, templateId }`. The transcript is addressed by id rather than by "whichever is active for the meeting", because meeting → transcript is 1:n (ADR-003 §3) and a summary has to name the exact transcript it was derived from.
2. **Template** — loaded from `summary_templates` and resolved: the base sections with the template's `add` / `replace` / `hide` overrides applied, one level of inheritance deep (ADR-004 §1). The resolved list is used for both the prompt and the snapshot, so the model can never be asked for a section the snapshot does not describe.
3. **Window** — the transcript is rendered as timestamped lines and fitted into a token budget (see *Cost control* below).
4. **Prompt** — a system message carrying the output contract and the anti-fabrication rules, plus a user message with the style options, the section specifications and the transcript. Pure: same template, options and transcript give the identical request.
5. **Completion** — one `POST /chat/completions`. The model contributes *content only*, keyed by section id; titles, formats and ordering come from the snapshot and are never read back from the answer.
6. **Parsing** — tolerant, then terminal. See *Structured output* below.
7. **Persistence** — the `Summary` is stored as JSONB with its queryable metadata in real columns, carrying the tenant/user/session scope and the full template snapshot.

### The system default template

`src/summary/template.ts` holds the system template (`scope: "system"`), seeded into the database on worker start. Five sections, in reading order:

| Section id       | Title           | Format    | Purpose                                              |
| ---------------- | --------------- | --------- | ---------------------------------------------------- |
| `overview`       | Overview        | `prose`   | What the meeting was about and what it achieved      |
| `key-points`     | Key Points      | `bullets` | The substantive points, with their reasoning         |
| `decisions`      | Decisions       | `bullets` | Only what was actually settled                       |
| `action-items`   | Action Items    | `table`   | Rows of `task` / `owner` / `due`, `null` when unstated |
| `open-questions` | Open Questions  | `bullets` | Raised and left unanswered, or explicitly deferred   |

The separation between "discussed", "decided" and "assigned" is the point of the split — it is what makes the output skimmable and what keeps the model from turning a suggestion into a commitment. Every section may legitimately come back empty; the prompt says so explicitly, because a model that feels obliged to fill a heading will invent an owner or a deadline.

Template versions are immutable. Changing a section's wording means bumping `version` in code, which inserts a new row and leaves the old one readable — a summary produced last month has to stay explicable in terms of the template it was actually produced with (ADR-004 §2). Seeding is therefore `ON CONFLICT DO NOTHING`, never an update.

Section titles are stored data rather than UI chrome, so they are not routed through i18n: they travel inside the immutable snapshot and must read the same whenever the summary is opened again. Section *ids* are stable, so a client that wants localized headings maps them by id; the language of the generated content is `options.outputLanguage`.

### Structured output

The summary is JSON with sections, not a Markdown blob (ADR-004 §5) — Markdown is trivially derived from it, and the reverse is not.

Parsing is deliberately lopsided. Everything recoverable is recovered without a second call: a ```json fence, prose wrapped around the object, a bare array instead of the envelope, an object keyed by section id, a single string where an array was asked for, a prose section split into sentences, extra sections the template does not have. Only one failure cannot be absorbed — an answer containing none of the requested section ids.

That failure buys **exactly one repair turn**: the conversation is replayed with the bad answer and the parser's own complaint appended. One, because a model that ignores the output contract twice is a prompt or model problem that a human needs to see, and every attempt is a paid call over the same transcript; not zero, because a stray sentence around otherwise perfect JSON is by far the most common failure and quoting the complaint back fixes it almost every time. If the repair also fails, the job dead-letters immediately as `SUMMARY_RESPONSE_INVALID` with the model's answer logged, truncated, as evidence.

A model that simply *skips* sections is not a parse failure: the sections are stored empty and logged as `summary.sections.missing`. The snapshot still describes them.

### Cost control

`docs/COST-MODEL.md` budgets 12–15k input tokens per meeting hour, which is roughly what an hour of speech transcribes to, and that assumption is what makes the marginal cost per hour predictable. `SUMMARY_MAX_INPUT_TOKENS` (default 14,000) enforces it rather than trusting every meeting to be an hour long.

A transcript that fits is passed whole. One that does not keeps its **head and its tail** and elides the middle, on segment boundaries, with a visible marker saying how many segments were dropped. The shares are 40% head / 60% tail: meetings put their framing at the start and their decisions and action items at the end, and the negotiation in the middle is the most compressible part. The marker is not decoration — an unmarked jump between two unrelated moments invites the model to invent a bridge. Truncation is logged as `transcript.windowed` with `truncated: true`.

Token estimation is `characters / 4`, without a tokenizer dependency: tying the estimate to one model family's vocabulary is exactly the coupling ADR-005 avoids. It is meant to be conservative, not exact. A four-hour workshop therefore costs the same as a one-hour meeting instead of quadrupling the bill or failing on context length *after* the tokens were paid for.

Where a full-fidelity long-meeting summary is wanted, the successor is map-reduce over windows rather than a larger single prompt — out of scope here, and the windowing lives behind one function to keep it a contained change.

## Idempotency

A worker that is killed mid-job must not leave a duplicate behind when the queue hands the job out again. Three things together guarantee that:

- **Deterministic identifiers.** The transcript id is a version-5 UUID derived from the job id, and each segment id is derived from the transcript id plus its index. The same job and the same response always produce byte-identical output.
- **A unique `job_id` column.** The insert is `ON CONFLICT (job_id) DO NOTHING`; a replay finds the row it wrote before and reports `created: false`.
- **One transaction.** Deactivating the previous transcript and inserting the new one commit together, and a partial unique index on `is_active` makes two active transcripts for one meeting impossible at the database level rather than by convention.

The cost of a crash is therefore a repeated transcription, never a second transcript. Reprocessing with a different model uses a *different* job id and deliberately creates a new transcript — meeting → transcript is 1:n (ADR-003 §3).

The summary side works the same way, and one step earlier as well:

- **The summarize job id is derived**, from the transcript id plus the template id, and used as the pg-boss singleton key. A replayed transcribe job recomputes the same id, so the second `send` is a no-op instead of a second paid LLM call. Summarizing the same transcript with a *different* template is a different id and deliberately creates a second summary — meeting → summary is 1:n (ADR-004 §3).
- **The summary id is derived from the summarize job id**, and `summaries.job_id` is unique, so a retry that crashed after the model answered adopts its own earlier row.
- **A partial unique index on `(meeting_id, template_id) WHERE is_active`** enforces "one active summary per template and meeting" in the database. Superseding and inserting share a transaction.

Idempotency matters more here than for transcription: by the time the write happens, the money has already been spent.

### Chaining the summary onto the transcript

The transcribe handler enqueues the summarize job after the transcript is committed. **That enqueue never fails the transcribe job.** Rethrowing there would hand the queue a failure whose only retry is a second full transcription — minutes of GPU time — to fix a queue insert that takes milliseconds. It is logged as `summary.enqueue_failed` and the transcribe job still succeeds. Nothing is lost silently: because the summarize job id is derived from the transcript, replaying the transcribe job or requesting the summary through the API lands on the exact same id, and the singleton key keeps that from ever producing two summaries.

## Retries and dead-lettering

Errors are split into retryable and terminal (`src/errors.ts`), because the two need opposite treatment:

| Code                             | Retryable | Typical cause                                     |
| -------------------------------- | --------- | ------------------------------------------------- |
| `TRANSCRIPTION_UNAVAILABLE`      | yes       | backend booting, loading a model, 5xx, 429        |
| `AUDIO_FETCH_FAILED`             | yes       | object storage hiccup                             |
| `TRANSCRIPT_PERSIST_FAILED`      | yes       | database unavailable                              |
| `INTERNAL_ERROR`                 | yes       | anything unanticipated                            |
| `MANIFEST_NOT_FOUND`             | no        | session was never finalized                       |
| `AUDIO_EMPTY`                    | no        | manifest inconsistent, or no chunks at all        |
| `AUDIO_DECODE_FAILED`            | no        | backend refused the bytes (400/415/422)           |
| `TRANSCRIPTION_REJECTED`         | no        | bad model name, unauthorized, payload too large   |
| `TRANSCRIPTION_RESPONSE_INVALID` | no        | backend answered in an unexpected shape           |
| `TRANSCRIPT_INVALID`             | no        | mapped result violates the transcript schema      |
| `JOB_PAYLOAD_INVALID`            | no        | message on the queue is not a payload we know     |
| `SUMMARY_UNAVAILABLE`            | yes       | summary backend unreachable, 5xx, rate limited    |
| `SUMMARY_PERSIST_FAILED`         | yes       | database unavailable                              |
| `SUMMARY_REJECTED`               | no        | bad model name, unauthorized, prompt too large    |
| `SUMMARY_RESPONSE_INVALID`       | no        | unusable model output after one repair attempt    |
| `SUMMARY_INVALID`                | no        | mapped result violates the summary schema         |
| `SUMMARY_TEMPLATE_NOT_FOUND`     | no        | template missing, or not visible to the tenant    |
| `TRANSCRIPT_NOT_FOUND`           | no        | transcript deleted, or belongs to another tenant  |
| `TRANSCRIPT_EMPTY`               | no        | transcript has no text to summarize               |

Retryable failures get `WORKER_RETRY_LIMIT` attempts with exponential backoff, which comfortably covers a Whisper container that is slow to start. Terminal failures go straight to the dead-letter queue without burning retries — repeating them cannot change the outcome.

The split matters more on the summary side, where every attempt is a paid API call rather than local GPU time. The retry budget there exists for backend outages and rate limits only; anything the model itself got wrong is terminal on the first try, because paying four times for the same wrong answer helps nobody.

Dead-lettered jobs land on `transcribe-dead-letter` or `summarize-dead-letter` and stay there; nothing consumes those queues, which is deliberate: they are evidence, and silently dropping them would hide a broken pipeline. Once the cause is fixed, an operator replays them with pg-boss's `redrive`, and the idempotent writes make a replay safe even for jobs that had already produced a transcript or a summary.

The failure is also recorded on the `jobs` row with its machine-readable code before it is handed back to the queue, so the API can report it through the job status endpoint without reading pg-boss internals.

## Database schema

Four tables, created with `CREATE TABLE IF NOT EXISTS` under an advisory lock on worker start (`src/db/schema.ts`):

- **`transcripts`** — the transcript document as JSONB plus the metadata worth querying: tenant, user, meeting, session, job, model and model version, schema version, language, `is_active`, `recorded_at`. A partial unique index on `(meeting_id) WHERE is_active` enforces ADR-003 §3.
- **`summaries`** — the summary document as JSONB, including its template snapshot, plus tenant, user, meeting, session, job, transcript, template id and version, model, prompt version, `is_active`. A partial unique index on `(meeting_id, template_id) WHERE is_active` enforces ADR-004 §3.
- **`summary_templates`** — templates keyed by `(id, version)`, because a template change is a new version rather than an in-place edit. System templates carry no tenant; user templates are tenant scoped, and `loadTemplate` filters on that so a payload naming another tenant's template finds nothing instead of leaking it.
- **`jobs`** — job state as defined by `shared/src/job.ts`, for both job types. The pg-boss row is an implementation detail with its own retention; this table is what the API reports and what outlives the queue.

**Why plain SQL and no ORM:** pg-boss already owns a PostgreSQL connection and runs its own migrations at start (ADR-006 §3). A schema this size does not justify a migration runner plus an ORM, and `src/db/schema.ts` is the entire schema in readable form. Queries go through `postgres.js`, which is a tagged-template driver rather than a query layer. When the REST API grows real query needs, adopting a proper migration tool is a contained change with this file as the starting point. ADR-006 explicitly left the query layer open as an implementation detail — this is that detail, not a commitment.

## Configuration

| Variable                     | Default                     | Meaning                                                       |
| ---------------------------- | --------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`               | —                           | PostgreSQL, shared with pg-boss                               |
| `S3_ENDPOINT`                | —                           | MinIO or any S3-compatible endpoint                           |
| `S3_REGION`                  | `us-east-1`                 |                                                               |
| `S3_BUCKET`                  | —                           | Bucket holding the recordings                                 |
| `S3_ACCESS_KEY`              | —                           |                                                               |
| `S3_SECRET_KEY`              | —                           |                                                               |
| `WHISPER_BASE_URL`           | `http://whisper:8000/v1`    | OpenAI-compatible base URL, including `/v1`                   |
| `WHISPER_MODEL`              | `Systran/faster-whisper-small` | Full model ID, sent with every request and provisioned at startup |
| `WHISPER_API_KEY`            | unset                       | Bearer token; self-hosted backends need none                  |
| `WHISPER_MODEL_AUTO_INSTALL` | `true`                      | Install `WHISPER_MODEL` on the backend before consuming jobs  |
| `WHISPER_MODEL_INSTALL_TIMEOUT_MS` | `2700000`             | Budget for waiting on the backend plus that download          |
| `WHISPER_LANGUAGE`           | unset                       | Fallback BCP-47 hint, below the meeting's and the user's choice |
| `WHISPER_VAD_FILTER`         | `true`                      | Send `vad_filter=true`; silence is skipped, not transcribed   |
| `WHISPER_TIMEOUT_MS`         | `1800000`                   | Whole-request timeout for one transcription                   |
| `SUMMARY_BASE_URL`           | `https://openrouter.ai/api/v1` | OpenAI-compatible chat base URL, including `/v1`           |
| `SUMMARY_MODEL`              | `openai/gpt-4o-mini`        | Model name sent with every summary request                    |
| `SUMMARY_API_KEY`            | unset                       | Bearer token; self-hosted backends need none                  |
| `SUMMARY_TEMPERATURE`        | `0.2`                       | Low but not zero, so repetitive input cannot cause looping    |
| `SUMMARY_MAX_INPUT_TOKENS`   | `14000`                     | Transcript budget; longer meetings get their middle elided    |
| `SUMMARY_MAX_OUTPUT_TOKENS`  | `4000`                      | Output ceiling for one summary                                |
| `SUMMARY_TIMEOUT_MS`         | `180000`                    | Whole-request timeout for one completion                      |
| `SUMMARY_JSON_MODE`          | `false`                     | Send `response_format: json_object`; off for portability      |
| `SUMMARY_CONCURRENCY`        | `2`                         | Summaries in flight per process (network-bound, not GPU)      |
| `WORKER_CONCURRENCY`         | `1`                         | Transcriptions in flight per process                          |
| `WORKER_RETRY_LIMIT`         | `4`                         | Attempts before a retryable failure is dead-lettered          |
| `WORKER_RETRY_DELAY_SECONDS` | `30`                        | Base delay of the exponential backoff                         |
| `WORKER_JOB_EXPIRE_SECONDS`  | `7200`                      | Budget per attempt; must exceed `WHISPER_TIMEOUT_MS`          |
| `LOG_LEVEL`                  | `info`                      |                                                               |

`WHISPER_TIMEOUT_MS` and `SUMMARY_TIMEOUT_MS` are bounded by what a timer can actually hold: a value above 2147483647 ms does not make the worker patient, it makes `setTimeout` overflow and fire after a millisecond, so the worker refuses to start rather than fail every request instantly. It also refuses to start when `WORKER_JOB_EXPIRE_SECONDS` does not exceed `WHISPER_TIMEOUT_MS` — the queue would hand the attempt to a second worker while the first is still waiting for its transcript, and the same audio would be transcribed twice on a host that was already too slow.

`WHISPER_VAD_FILTER` is on by default, and the reason is a failure mode rather than a preference: a recording that contains a long speechless stretch — a room recorded before anyone speaks — makes every Whisper size lock onto a repeated phrase, and the loop then runs on through the rest of the transcript. Running the backend's Silero VAD first means the model only ever sees audio with speech in it. The trade-off is that audio the VAD hears as silence is not transcribed at all; word and segment timestamps stay relative to the start of the submitted recording, so nothing downstream changes. A backend that does not implement the field ignores it, which keeps the ADR-005 swap free.

Switching the summary provider is those first three variables and nothing else — OpenRouter today, LM Studio, vLLM or Ollama later (ADR-005 §2). `SUMMARY_JSON_MODE` stays off by default because several self-hosted servers reject a `response_format` they do not implement, which would make the swap cost a code change; the prompt asks for JSON regardless and the parser is written for models that ignore the instruction.

## Logging

Structured JSON via pino. Every line emitted while a job runs carries `jobId`, `meetingId`, `sessionId`, `tenantId`, `userId` and `attempt`, plus an `event` name. Correlation is by field, not by message text, so the observability work can build on it without parsing prose.

- Transcription: `job.started`, `audio.assembled`, `transcription.completed`, `summary.enqueued`, `summary.enqueue_failed`, `job.succeeded`, `job.failed`, `job.settled`.
- Summary: `job.started`, `transcript.windowed`, `summary.completed`, `summary.output.malformed`, `summary.repair.completed`, `summary.output.repaired`, `summary.output.unrecoverable`, `summary.output.truncated`, `summary.sections.missing`, `job.succeeded`, `job.failed`, `job.settled`.

Summary lines additionally carry `transcriptId`, `templateId` and — where the backend reports them — `promptTokens` and `completionTokens`, which is what makes the assumptions in `docs/COST-MODEL.md` checkable against reality instead of against an estimate.

## Process lifecycle

A queue consumer stops for exactly one legitimate reason: somebody asked it to. `SIGINT` and `SIGTERM` therefore shut it down gracefully — running jobs finish, nothing new is fetched — log one `worker.stopping` line at **`warn`** and exit **0**. `warn` rather than `info` is deliberate: containers default to `LOG_LEVEL=info` and would show either, but the end-to-end harness runs the worker at `warn`, and so does any operator who has turned the volume down — and this is the one line that separates "someone stopped it" from "it vanished".

Every other way out is a fault and is reported as one. A failed startup, an exception that reached the top of the stack, a rejection nobody handled, the job queue stopping by itself, or the event loop simply running dry all log `worker.stopping` at **`error`** with a `reason` field, stop the queue **without** draining it — a process that has lost its footing is not worth waiting for, and the jobs are safer back on the queue — and exit **70** (sysexits `EX_SOFTWARE`). The last of those reasons is why the guard exists at all: a Node process whose event loop empties exits 0 without printing anything, and a supervisor reads 0 as "finished" — which a worker never is. See `src/lifecycle.ts`.

The shutdown gives back what the process holds — queue, metrics port, database pool — in reverse order of acquisition, including after a startup that only got halfway, so a failed start leaves no bound port behind. A release that fails on a **requested** stop stays a clean exit and logs `worker.shutdown-failed` at `warn`: during a `compose down` the database and the worker are signalled at the same moment, so a pool close that loses its connection is the ordinary shape of a correct teardown, not a crash.

Three timeouts have to be read together, smallest first:

| Budget                                  | Value | Where                                          |
| --------------------------------------- | ----- | ---------------------------------------------- |
| Drain: how long in-flight jobs may finish | 20s  | `QUEUE_DRAIN_TIMEOUT_MS` in `src/index.ts`      |
| Release ceiling: the whole teardown       | 45s  | `src/lifecycle.ts`                              |
| Container grace before `SIGKILL`          | 60s  | `stop_grace_period` on the `worker` service     |

Each has to sit above the one before it. A ceiling below the drain window fires on every slow job and reports an ordinary restart as a fault; a container grace below the ceiling (Docker's default is **10s**) sends `SIGKILL` mid-teardown and the graceful drain exists only on paper. A job cut short by the drain window is not lost — pg-boss returns it to the queue and the write is idempotent. After a fault the release is capped far shorter, at 5s, since nothing is being waited for on that path.

## Tests

```bash
pnpm test                              # unit tests; no services required

QUORUM_INTEGRATION=1 QUORUM_TEST_AUDIO=/path/to/recording.webm \
  pnpm vitest run worker/test/integration.test.ts

QUORUM_SUMMARY_INTEGRATION=1 SUMMARY_API_KEY=... SUMMARY_MODEL=... \
  pnpm vitest run worker/test/summary-integration.test.ts
```

The unit tests mock object storage and HTTP. They cover manifest assembly, the response-to-`Transcript` mapping against fixtures of both response shapes, prompt construction from a template plus a transcript fixture, template override resolution, transcript windowing, the response-to-`Summary` mapping including every malformed-output case, the enqueue-on-transcript-success chain, startup model provisioning against a faked backend, the idempotency rules and the error taxonomy.

Both integration suites are opt-in. The transcription one needs a running MinIO, PostgreSQL and Whisper endpoint plus a real recording; the summary one needs PostgreSQL and a real OpenAI-compatible endpoint, and costs money per run. They are excluded from the default run because CI has none of those services — and the summary suite asserts on the *structure* of the answer, never on its wording, since a live model is not deterministic.

The transcription integration suite talks to a Whisper endpoint directly rather than through the worker's startup, so it does not get provisioning for free. `speaches` never downloads a model implicitly, and the first request for an uninstalled one answers `404`. Install it once per volume:

```bash
curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small
```
