# @quorum/worker

Job worker for the transcription pipeline. It consumes `transcribe` jobs from the pg-boss queue that the recording endpoint fills on `session.end`, turns the stored chunks back into an audio file, sends it to an OpenAI-compatible Whisper endpoint and persists the result as an immutable `Transcript` (ADR-003).

The worker is a separate process and a separate workspace from the API server: transcription is CPU/GPU-bound and long-running, and scaling or restarting it must not touch the HTTP surface.

## Pipeline

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

## macOS development

Docker on macOS has no GPU access, so the CUDA image is meaningless there. Both documented paths work without a code change:

1. **CPU image (full stack parity).** Set `WHISPER_IMAGE_TAG=latest-cpu`, `WHISPER_DEVICE=cpu` and a `small`/int8 model in `.env`, then start the stack as usual. Right for integration and end-to-end tests; slow but faithful.
2. **Host-native Whisper (speed).** Run `whisper.cpp --server` or `mlx-whisper` on the host with Metal, leave the `whisper` container out, and point the worker at it:

   ```bash
   WHISPER_BASE_URL=http://host.docker.internal:8080/v1   # worker in a container
   WHISPER_BASE_URL=http://127.0.0.1:8080/v1              # worker on the host
   ```

   This gives faster-whisper-grade word timings, not whisperX forced alignment — fine for feature work, not for judging alignment quality.

## Idempotency

A worker that is killed mid-job must not leave a duplicate behind when the queue hands the job out again. Three things together guarantee that:

- **Deterministic identifiers.** The transcript id is a version-5 UUID derived from the job id, and each segment id is derived from the transcript id plus its index. The same job and the same response always produce byte-identical output.
- **A unique `job_id` column.** The insert is `ON CONFLICT (job_id) DO NOTHING`; a replay finds the row it wrote before and reports `created: false`.
- **One transaction.** Deactivating the previous transcript and inserting the new one commit together, and a partial unique index on `is_active` makes two active transcripts for one meeting impossible at the database level rather than by convention.

The cost of a crash is therefore a repeated transcription, never a second transcript. Reprocessing with a different model uses a *different* job id and deliberately creates a new transcript — meeting → transcript is 1:n (ADR-003 §3).

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
| `JOB_PAYLOAD_INVALID`            | no        | message on the queue is not a transcribe payload  |

Retryable failures get `WORKER_RETRY_LIMIT` attempts with exponential backoff, which comfortably covers a Whisper container that is slow to start. Terminal failures go straight to the dead-letter queue without burning retries — repeating them cannot change the outcome.

Dead-lettered jobs land on `transcribe-dead-letter` and stay there; nothing consumes that queue, which is deliberate: they are evidence, and silently dropping them would hide a broken pipeline. Once the cause is fixed, an operator replays them with pg-boss's `redrive`, and the idempotent write makes a replay safe even for jobs that had already produced a transcript.

The failure is also recorded on the `jobs` row with its machine-readable code before it is handed back to the queue, so the API can report it through the job status endpoint without reading pg-boss internals.

## Database schema

Two tables, created with `CREATE TABLE IF NOT EXISTS` on worker start (`src/db/schema.ts`):

- **`transcripts`** — the transcript document as JSONB plus the metadata worth querying: tenant, user, meeting, session, job, model and model version, schema version, language, `is_active`, `recorded_at`. A partial unique index on `(meeting_id) WHERE is_active` enforces ADR-003 §3.
- **`jobs`** — job state as defined by `shared/src/job.ts`. The pg-boss row is an implementation detail with its own retention; this table is what the API reports and what outlives the queue.

**Why plain SQL and no ORM:** pg-boss already owns a PostgreSQL connection and runs its own migrations at start (ADR-006 §3). Two tables do not justify a migration runner plus an ORM, and `src/db/schema.ts` is the entire schema in readable form. Queries go through `postgres.js`, which is a tagged-template driver rather than a query layer. When the REST API grows real query needs, adopting a proper migration tool is a contained change with this file as the starting point. ADR-006 explicitly left the query layer open as an implementation detail — this is that detail, not a commitment.

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
| `WHISPER_MODEL`              | `small`                     | Model name sent with every request                            |
| `WHISPER_API_KEY`            | unset                       | Bearer token; self-hosted backends need none                  |
| `WHISPER_LANGUAGE`           | unset                       | BCP-47 hint; unset means the backend detects the language     |
| `WHISPER_TIMEOUT_MS`         | `1800000`                   | Whole-request timeout for one transcription                   |
| `WORKER_CONCURRENCY`         | `1`                         | Transcriptions in flight per process                          |
| `WORKER_RETRY_LIMIT`         | `4`                         | Attempts before a retryable failure is dead-lettered          |
| `WORKER_RETRY_DELAY_SECONDS` | `30`                        | Base delay of the exponential backoff                         |
| `WORKER_JOB_EXPIRE_SECONDS`  | `7200`                      | Budget per attempt; must exceed `WHISPER_TIMEOUT_MS`          |
| `LOG_LEVEL`                  | `info`                      |                                                               |

## Logging

Structured JSON via pino. Every line emitted while a job runs carries `jobId`, `meetingId`, `sessionId`, `tenantId`, `userId` and `attempt`, plus an `event` name (`job.started`, `audio.assembled`, `transcription.completed`, `job.succeeded`, `job.failed`, `job.settled`). Correlation is by field, not by message text, so the observability work can build on it without parsing prose.

## Tests

```bash
pnpm test                              # unit tests: manifest, mapping, idempotency, error mapping
QUORUM_INTEGRATION=1 QUORUM_TEST_AUDIO=/path/to/recording.webm \
  pnpm vitest run worker/test/integration.test.ts
```

The unit tests mock object storage and HTTP; they cover manifest assembly, the response-to-`Transcript` mapping against fixtures of both response shapes, the idempotency rules and the error taxonomy.

The integration suite is opt-in and needs a running MinIO, PostgreSQL and Whisper endpoint, plus a real recording to point `QUORUM_TEST_AUDIO` at. It is excluded from the default run because CI has none of those services and the Whisper model download alone takes minutes and gigabytes.

`speaches` does not download a model implicitly — the first request for an uninstalled model answers `404`, which the worker reports as `TRANSCRIPTION_REJECTED`. Install it once per volume:

```bash
curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small
```
