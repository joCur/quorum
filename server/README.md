# `@quorum/server`

Fastify API server. It contains the auth foundation — Keycloak-issued JWT validation and the
tenant-scoped request context every handler builds on — and the WebSocket recording endpoint of
ADR-002.

## Container image

`Dockerfile` in this directory builds the production image, but its build context is the
**repository root** — the server consumes the `@quorum/shared` workspace and the root pnpm
lockfile:

```bash
docker build -f server/Dockerfile .      # or: docker compose build api
```

It is multi-stage: pnpm comes from Corepack with the version pinned in the root `packageManager`
field, both workspaces are compiled in a build stage, and the runtime stage carries only production
dependencies, runs as the unprivileged `node` user with `NODE_ENV=production`, and health-checks
itself against `/healthz`.

## The tenant/user scoping convention

ADR-001 requires tenant and user scope in **every** data object from day one. That is a convention
this package enforces rather than documents:

1. **Identity comes only from the validated token.** `request.requireContext()` returns a
   `RequestContext` with `userId` (the `sub` claim) and `tenantId` (the `tenant_id` claim). A
   tenant sent in a body, a query parameter or a header is attacker-controlled and is never read.
2. **A token without a tenant is rejected** with `403 missing_tenant`. There is no "global" or
   "default" tenant to fall back to — a request that cannot be scoped does not run.
3. **Authentication is default-deny.** The auth plugin installs one `onRequest` hook for the whole
   instance, including the WebSocket upgrade. A route is reachable without a token only if it
   declares `config: { public: true }` — currently just `/healthz`. Adding a route can therefore
   not accidentally leave it open; it can only be deliberately opened.
4. **Every table carries `tenant_id` and an owning `user_id`**, both `NOT NULL`, with the tenant
   column part of every index that serves a list query, and foreign keys pointing at tenant-scoped
   parents so the ADR-001 deletion cascade is enforced by the database rather than by application
   code. Object storage keys follow the same rule (see the layout below).
5. **Every query filters by `tenantId` from the context**, never by a value the caller supplied.
   Reads that find a row belonging to another tenant return `404`, not `403` — existence of another
   tenant's data is itself information.
6. **Log lines carry the scope.** The plugin attaches `userId` and `tenantId` to the request
   logger, so any later "which tenant did this?" question is answerable from the logs.

Handlers should therefore look like this:

```ts
app.get("/api/meetings", async (request) => {
  const { tenantId, userId } = request.requireContext();
  return meetings.listForTenant({ tenantId, userId });
});
```

## Routes

| Route           | Auth                | Purpose                                                     |
| --------------- | ------------------- | ----------------------------------------------------------- |
| `/healthz`      | public              | Liveness/readiness probe. Carries no tenant data.            |
| `/api/me`       | access token        | Echoes the scope the request runs under.                     |
| `/ws/recording` | access token        | Chunk-streaming recording endpoint (ADR-002).                |
| `/api/meetings` | access token        | Meeting list with derived status, newest first, title search. |
| `/api/meetings/:meetingId` | access token | One meeting with its transcript, summaries and job rows. |
| `GET /api/meetings/:meetingId/audio` | access token | Streams the recording back, with byte ranges. |
| `DELETE /api/meetings/:meetingId` | access token | Deletes the meeting and everything derived from it. |

## Meetings API

`GET /api/meetings` returns the caller's own meetings, newest first.

| Query    | Meaning                                                                    |
| -------- | -------------------------------------------------------------------------- |
| `q`      | Case-insensitive substring match on the meeting title. Wildcards are literal. |
| `limit`  | 1–200, default 50.                                                          |
| `offset` | Page offset, default 0.                                                     |

`GET /api/meetings/:meetingId` adds the active transcript, the active summaries (one per template,
ADR-004 §3) and the job rows the pipeline stepper is built from. A meeting belonging to another
tenant — or to another user of the same tenant — answers `404`, as does an id that is not a UUID:
distinguishing the two cases would confirm that an id exists.

### Where the status comes from

The pipeline state is **derived on read** (`src/meetings/status.ts`) from the recording, the job
rows and the presence of a transcript and a summary — it is never stored on the meeting, so a
meeting can never disagree with its own artifacts. Two gaps are closed by that derivation rather
than by writing placeholder rows:

- A job row is written by the worker when it *picks the job up*. A finalized recording without a
  `transcribe` row is therefore reported as `queued` — which is exactly what it is.
- The `summarize` job is enqueued by the transcription worker once the transcript is stored, so its
  row appears later still. A stored transcript without a summary is reported as `summarizing`,
  covering both the queue wait and the run.

| Status        | Meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `recording`   | Session started, no manifest yet — the recording is open.   |
| `queued`      | Finalized; transcription has not started.                   |
| `transcribing`| The `transcribe` job is running.                            |
| `summarizing` | A transcript exists, no summary yet.                        |
| `ready`       | Transcript and summary are stored.                          |
| `failed`      | A stage failed; `failure` carries the stage, code, message. |

A failure never hides what succeeded: the transcript and the audio stay available, only the badge
reports the failure.

### Playback

`GET /api/meetings/:meetingId/audio` streams the chunk objects back as one continuous recording.

The audio is delivered **by the API, never by a URL pointing at object storage**. A presigned URL
is a bearer token for the recording: valid for whoever holds it, impossible to withdraw before it
expires, and invisible in the access logs of the service that issued it. Streaming through the API
means the tenant and user check runs on every request, including every seek.

- `Accept-Ranges: bytes`; a single `Range` is honored (`bytes=a-b`, `bytes=a-`, `bytes=-n`) and
  answered with `206` plus `Content-Range`. A range past the end is `416`. A syntax the server does
  not understand — a multipart range, for instance — falls back to the whole stream, which RFC 9110
  allows and which beats failing playback over a header no audio element sends.
- `Cache-Control: private, no-store` — the recording is personal data, no shared cache keeps a copy.
- Chunks are streamed one object at a time; a long recording is never held in memory.
- Nothing is written back: assembling on read keeps the chunk objects the single copy of the audio,
  which is also what makes the deletion cascade a prefix removal.
- `404 audio_not_available` while a recording is still open or its chunks are gone; the meeting
  itself stays reachable either way.

**Known limitation:** the chunks are the raw container stream as the browser produced it. A WebM
stream written incrementally carries no cue index, so a player can seek only over what it has
already buffered. Byte ranges are served correctly; container-level seeking needs a remuxing step,
which is its own ticket.

### Deletion (ADR-001)

`DELETE /api/meetings/:meetingId` is real, immediate and complete. No soft delete, no trash, no
grace period — that is the product promise, and a hidden retention window would break it
(design/STATES.md §6).

The cascade covers:

1. **Object storage** — every object under the session prefix: chunk objects, `session.json`,
   `manifest.json`. It works from a prefix listing rather than from the manifest, because objects
   the manifest never mentioned have to go too.
2. **Database**, in one transaction — summaries, transcripts, job rows, and the meeting itself.
3. **Queued work** — pg-boss rows carrying this meeting id. This reaches into pg-boss's own tables,
   deliberately: a `transcribe` job left in the queue would be picked up after the delete and write
   a fresh transcript for a meeting that no longer exists. pg-boss offers no delete-by-payload API,
   and the payload shape is ours.

**Storage goes first, the database second.** Both steps are idempotent, so the order decides what a
crash in between leaves behind: this way the meeting is still listed and the user can simply delete
it again. The reverse order would leave orphaned audio that nothing points at any more, which is
the one outcome the deletion promise cannot survive.

A meeting outside the caller's scope answers `404` and nothing is touched — not the rows, not the
objects.

**Backups.** ADR-001 requires removal from backups after a defined period. No backup path exists
yet: it is an open question owned by the infra ticket (`OPEN-QUESTIONS.md`, ADR-006), together with
the retention window itself. Until that lands, the guarantee this endpoint gives is the live one —
after the call, no residue exists in PostgreSQL or in object storage, and the tests verify both.

### The meetings table

The server owns exactly one table, `meetings` (`src/meetings/schema.ts`): the queryable index over
recordings. Object storage stays the source of truth for the audio itself. The row is written when
`session.start` succeeds and marked finalized on `session.end`.

Both writes are **best-effort**: capture integrity outranks listability, so an unavailable database
logs a warning and the recording continues. `session.end` repeats the same idempotent write, which
repairs a row that could not be written when the session started.

The worker owns `transcripts`, `summaries`, `summary_templates` and `jobs`; the server reads them
and never writes them. Each package applies its own statements under its own advisory lock, so
start order does not matter — and a server that comes up before the worker has created its tables
still serves the list, with every meeting reporting the state it actually has. Consolidating the
schema into a single owner is a follow-up.

## Recording endpoint

`GET /ws/recording` (WebSocket). The wire protocol is defined by `shared/src/recording-protocol.ts`
and is not extended here.

1. `session.start` → the server validates the announced audio format, writes `session.json` to
   object storage and answers `session.ready` with the session id.
2. Binary chunk frames (`[16 B session UUID][4 B seq][8 B timestampOffset][payload]`) are written to
   object storage; a `chunk.ack` with `persistedSeq` is sent **only after a successful write**.
   `persistedSeq` is the highest sequence number for which every chunk from 0 up is persisted, so
   the client may drop its IndexedDB buffer up to that point.
3. `session.pause` / `session.resume` record wall-clock marks. A `session.resume` on a fresh
   connection is also the **reconnect** path: session state is rebuilt from a prefix listing in
   object storage and answered with a `chunk.ack`, so a client can continue after the server was
   killed mid-recording.
4. `session.end` writes `manifest.json`, enqueues a `transcribe` job via pg-boss and answers
   `session.finalized`. If chunks are still missing (`lastSeq > persistedSeq`) the session is not
   finalized and the server re-acknowledges instead.

The protocol has no error message type, so failures are reported through WebSocket close codes:
1002 protocol error, 1008 policy violation (format, scope, unauthorized), 1009 chunk too large,
1011 internal error. A missing or invalid access token is refused earlier, during the HTTP upgrade,
with a plain `401`.

### Validation

- The announced format must be one of WebM/Opus, Ogg/Opus or MP4/AAC (`src/recording/audio-format.ts`).
- The first chunk must carry the matching container magic bytes — this is not a generic blob upload.
- Per-chunk payload limit: 1 MiB; `@fastify/websocket` enforces the same limit at the transport level.
- Sequence numbers more than 1024 ahead of `persistedSeq` are refused.
- Duplicate and out-of-order sequence numbers are handled idempotently.

### Abuse and cost limits

The GPU worker is the expensive part of this system: every recorded hour eventually buys GPU time
and model tokens (`COST-MODEL.md`, roughly 0.10 € marginal cost per meeting hour). The recording
endpoint therefore bounds what one connection and one user can push into the pipeline, in
`src/recording/limits.ts`.

| Limit             | Default        | What it bounds                                           |
| ----------------- | -------------- | -------------------------------------------------------- |
| Session duration  | 4 h            | Wall clock of a single recording.                         |
| Parallel sessions | 3 per user     | Open recording sessions of one user, per server process.  |
| Chunk rate        | 20/s sustained | Frames per second on one connection.                      |
| Byte rate         | 4 MiB/s        | Bytes per second on one connection.                       |
| Burst             | 10 s           | Seconds' worth of both rates spendable at once.           |
| Storage quota     | 50 GiB         | Stored audio over all of a user's meetings.               |
| Monthly recording | 100 h          | Seconds recorded in the current calendar month (UTC).     |
| REST requests     | 300/min        | Requests per user across the API.                         |
| Regenerate        | 10/min         | Requests per user to the one route that costs model calls. |

**Every limit is looked up per user**, through `RecordingLimitsResolver`; no enforcement site
reads a constant of its own. In V1 the answer is always the environment configuration
(`StaticRecordingLimitsResolver`), so everybody gets the same numbers — but plan tiers are then a
different implementation of that one interface rather than a change at every place a limit is
checked. The limits are resolved once when a session starts and stay fixed for its life, so a
recording in flight cannot have the rules changed under it.

A live recording sends 0.5–1 chunk and about 4 KiB per second (chunks are 1–2 s of audio), so the
rate defaults sit 20x and 1000x above live speed. The burst allowance is what makes a reconnect
work: a client that buffered audio while offline replays it as fast as the socket allows, and that
must not look like an attack.

**The duration limit does not throw the recording away.** When it is passed, the server finalizes
the session through exactly the same path `session.end` takes — manifest written, transcription
enqueued, `session.finalized` sent — and only then closes the socket. What was recorded stays a
normal, playable meeting; only the audio past the limit is lost. The check runs when a frame
arrives rather than on a timer: a session that sends nothing costs nothing, and every frame that
would add cost is checked before it is accepted. A reconnect to a session that ran past the limit
while it was disconnected is stopped the same way instead of being revived.

**The session clock is wall clock from `session.start`, and it keeps running through a pause.**
A four-hour limit means four hours between starting and being stopped, not four hours of audio.
That is deliberate: an open session holds a slot, a socket and a growing set of objects whether or
not audio is flowing, and a pause that stopped the clock would let one session live forever. The
recorded-seconds side of the quota is the opposite and counts audio time, so a paused meeting does
not spend a user's monthly hours while nothing is being recorded.

### Quotas

Two durable per-user quotas are checked when a session starts, and a session over either of them is
refused before a single byte is written: total stored audio, and seconds recorded in the current
calendar month (UTC).

They are summed from the meetings themselves — `meetings.audio_bytes` and
`meetings.recorded_seconds`, written during and at the end of every recording — rather than from a
counter table. A counter would have to be decremented on delete and would drift the first time a
decrement was lost; a sum over per-meeting facts cannot drift, is deleted for free by the ADR-001
cascade, and is recomputable from object storage if a number is ever wrong. The transcript-derived
duration the meeting list shows is a different number with a different job: it exists only after
transcription, and a quota cannot wait for the pipeline it is meant to protect.

Usage is written every `QUOTA_USAGE_FLUSH_CHUNKS` chunks while recording, so a crash mid-session
cannot cost storage that counts for nothing, and the store keeps the larger of the old and new
value — a reconnecting connection counts from zero and must not make a session look smaller. At
finalize the byte count is replaced by a listing of what object storage actually holds, which also
repairs any session that was partly written by a connection that is gone.

Checked at the start rather than continuously: a running session is bounded by the maximum session
duration anyway, so the worst overshoot is one full-length session per open connection — bounded in
turn by the parallel-session cap — in exchange for keeping a database query off the chunk path. If
the usage cannot be read at all, the session is allowed: losing a recording is worse than letting
one past a quota, and every other limit still applies.

Violations are reported through the close frame, and the reason is a **machine-readable code**
defined in `@quorum/shared` (`limits.ts`), never a sentence — the client renders the message through
i18n:

| Close code            | Reason                             | Meaning                                      |
| --------------------- | ---------------------------------- | -------------------------------------------- |
| 1000 normal           | `limit.session_duration_exceeded`  | Finalized by the server; the meeting exists.  |
| 1008 policy violation | `limit.parallel_sessions_exceeded` | Too many open sessions for this user.         |
| 1008 policy violation | `limit.chunk_rate_exceeded`        | Too many frames per second.                   |
| 1008 policy violation | `limit.byte_rate_exceeded`         | Too many bytes per second.                    |
| 1008 policy violation | `limit.storage_quota_exceeded`     | The user's stored audio fills their quota.     |
| 1008 policy violation | `limit.monthly_hours_quota_exceeded` | The month's recording allowance is spent.   |

The rate buckets are per connection and in memory; the parallel-session registry is per server
process. Both are cheap ceilings against one client misbehaving, not cluster-wide accounting: with
several API replicas the effective session cap is the configured number times the replica count.

### REST rate limits

The recording socket is metered per connection because that is where the audio arrives. The REST
API is metered **per user** — a request there is cheap on its own and only becomes a problem in
volume, and a per-connection budget would be free to reset by reconnecting. `@fastify/rate-limit`
does the counting; the policy is ours:

- The key is the tenant and user of the validated token, so one user cannot spend another's
  allowance and a shared address — an office, a mobile carrier — is not one bucket. Only a request
  without a context falls back to the IP.
- The numbers come from the same per-user limits resolver everything else uses.
- `GET /healthz` is exempt (`config: { rateLimit: false }`): an orchestrator polls it on a schedule
  and must never be throttled.
- `POST /api/meetings/:id/summaries` declares `config: { expensive: true }` and is metered against
  the much smaller summary allowance, because every accepted request there buys a model call while
  the rest of the API reads rows the pipeline already produced.
- Exceeding it answers `429` with `{"error": "limit.request_rate_exceeded"}` — the same
  machine-readable code style as every other limit here.

Rate limiting runs after authentication, so an unverifiable token is refused with `401` before it
ever reaches a user bucket, and is metered by address instead.

### Queue fairness

The transcription queue is served by a small number of GPU workers and a job can take minutes.
Without an ordering rule, a user who finalizes twenty recordings at once puts twenty jobs at the
head of the queue and everybody else waits behind all of them.

**The mechanism:** a job is enqueued with a pg-boss priority equal to the negative count of jobs
that user already has waiting on that queue. pg-boss serves higher priority first, so a user's first
job outranks their second, and a newcomer's first job outranks a backlog. With users A (five jobs
queued) and B (none), B's next job has priority 0 and A's has -5, so B goes first.

It costs one count query per enqueue — once per finished recording, not per chunk — and keeps no
state of its own, so there is nothing to reconcile after a restart: the queue is the state. A
deliberate non-choice is a per-user concurrency cap, which would need a scheduler holding jobs back
and deciding when to release them — a second source of truth about what is running, where priority
is just a column on a row that is already there. If the count cannot be taken, the job is enqueued
at the neutral priority: losing the transcription of a finished recording would be far worse than
losing fairness for one job.

### Where the recording scope comes from

The recording plugin never derives a tenant itself; it asks a `RecordingContextProvider`.

- **`JwtRecordingContextProvider`** (default) takes `tenantId`/`userId` from the validated access
  token and ignores every header. This is what runs in production.
- **`HeaderRecordingContextProvider`** reads `x-quorum-tenant-id` / `x-quorum-user-id` and exists
  only for local development. It is inert unless `RECORDING_ALLOW_HEADER_AUTH=true`, and that flag
  additionally marks the upgrade public so the header values are actually reachable. Never set it
  outside a developer machine — it lets any caller claim any tenant.

### How the WebSocket upgrade carries the token

A browser cannot set an `Authorization` header on a WebSocket upgrade, and a query parameter would
end up in access logs and proxy history. The upgrade may therefore carry the access token in
`Sec-WebSocket-Protocol` instead:

```
Sec-WebSocket-Protocol: quorum.bearer.v1, <access token>
```

The browser client offers the two values in exactly that order
(`new WebSocket(url, ["quorum.bearer.v1", token])`). The server takes the entry following the marker
as the token and runs it through the same verification as a header token — JWKS, issuer, audience,
tenant claim — so neither channel is weaker than the other. The handshake response echoes only the
marker (`Sec-WebSocket-Protocol: quorum.bearer.v1`), which RFC 6455 requires and which keeps the
token out of the response.

The marker, the order the token follows it in and the server's selection rule are defined once in
`@quorum/shared` (`websocket-auth.ts`) and imported by both sides, so the string cannot drift apart
between client and server.

The `Authorization` header stays the primary channel and wins whenever it is present; the
subprotocol is only consulted on an upgrade request that has no such header. A refused upgrade is
answered with `401` and its socket is destroyed, so a rejected client cannot stall shutdown.

## Storage layout (ADR-001 tenant/user scoping)

```
tenants/<tenantId>/users/<userId>/sessions/<sessionId>/session.json
tenants/<tenantId>/users/<userId>/sessions/<sessionId>/chunks/<seq:010d>.bin
tenants/<tenantId>/users/<userId>/sessions/<sessionId>/manifest.json
```

One object per chunk instead of a multipart upload: the key is a pure function of the sequence
number, which makes re-sends idempotent overwrites and lets the server rebuild `persistedSeq` from a
prefix listing after a crash. Concatenating the chunks into a single audio object is the
transcription worker's job, driven by the manifest.

## Encryption at rest

`scripts/minio-init.sh` runs as the `minio-init` one-shot service, creates the bucket and enables
**default SSE-S3** on it, so an object cannot be written unencrypted. This requires MinIO's built-in
KMS: set `MINIO_KMS_SECRET_KEY=<key-name>:<base64 32 bytes>` in `.env` (see `.env.example`) — back
that key up, without it the stored audio is unreadable. The server additionally sends `S3_SSE`
(default `AES256`) with every write.

## Configuration

All configuration is environment-driven and validated at startup by `loadConfig` (`src/config.ts`);
an invalid value fails the process rather than degrading silently. See `.env.example` for the full
list with defaults.

| Variable                 | Purpose                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `OIDC_ISSUER_URL`        | Issuer used for JWKS retrieval — inside compose, the container-internal URL.    |
| `OIDC_PUBLIC_ISSUER_URL` | Second accepted `iss` value: the one browser-obtained tokens actually carry.    |
| `OIDC_JWKS_URI`          | Optional override; defaults to `<issuer>/protocol/openid-connect/certs`.        |
| `OIDC_AUDIENCE`          | Audience the access token must contain. Default `quorum-api`.                   |
| `OIDC_TENANT_CLAIM`      | Claim holding the tenant. Default `tenant_id`.                                  |
| `RECORDING_ALLOW_HEADER_AUTH` | Development-only header scope for the recording upgrade. Default `false`.  |
| `RECORDING_MAX_SESSION_SECONDS` | Server-side hard stop on recording length. Default `14400` (4 h).        |
| `RECORDING_MAX_PARALLEL_SESSIONS` | Open recording sessions per user. Default `3`.                         |
| `RECORDING_MAX_CHUNKS_PER_SECOND` | Sustained frames per second per connection. Default `20`.              |
| `RECORDING_MAX_BYTES_PER_SECOND` | Sustained bytes per second per connection. Default `4194304` (4 MiB).    |
| `RECORDING_RATE_BURST_SECONDS` | Seconds' worth of both rates spendable at once. Default `10`.             |
| `QUOTA_STORAGE_BYTES`    | Stored audio per user. Default `53687091200` (50 GiB).                          |
| `QUOTA_MONTHLY_RECORDED_SECONDS` | Recording seconds per calendar month. Default `360000` (100 h).         |
| `QUOTA_USAGE_FLUSH_CHUNKS` | Chunks between two usage writes during a recording. Default `64`.             |
| `API_RATE_LIMIT_MAX`     | REST requests per user per window. Default `300`.                               |
| `API_RATE_LIMIT_WINDOW_SECONDS` | Length of that window. Default `60`.                                     |
| `API_RATE_LIMIT_SUMMARY_MAX` | Regenerate requests per user per window. Default `10`.                      |
| `DATABASE_URL`, `S3_*`   | Queue and object storage, see `.env.example`.                                   |
| `HOST`, `PORT`, `LOG_LEVEL` | Listener and logging.                                                        |

Keys are fetched from the realm JWKS lazily and cached by `jose`; a rotated signing key is picked up
on the next unknown `kid` without a restart.

## Tests

`pnpm test` from the repository root runs them (that is what CI runs too).

The auth tests generate an RSA key pair in-process and sign their own tokens, so they need neither a
network nor a running Keycloak, and they cover the valid case plus expired, wrong-issuer,
wrong-audience, unknown-key, `alg: none`, malformed-header and missing-tenant tokens, default-deny
on unknown routes, and that a token-scoped recording session ignores forged tenant headers.

The integration tests in `test/integration.test.ts` run against the real MinIO and Postgres from
`docker-compose.yml` and are opt-in:

```bash
QUORUM_INTEGRATION=1 pnpm vitest run server/test/integration.test.ts
QUORUM_INTEGRATION=1 pnpm vitest run server/test/meeting-store-integration.test.ts
```

The meeting-store tests apply the worker's migration list rather than a copy of it, so a change on
the worker side that breaks the server's read queries fails there instead of in production.

## Manual verification — compose up, get a token, call a protected endpoint

```bash
cp .env.example .env      # then fill in the CHANGE_ME values
# The dev override publishes Postgres and the MinIO S3 API on the host, which the base compose
# file keeps internal — a server started outside the stack needs them.
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  up -d postgres keycloak minio minio-init
```

Wait until Keycloak reports healthy — the realm import runs on first start:

```bash
docker compose ps keycloak      # expect "healthy" after roughly 30 seconds
docker compose logs keycloak | grep "imported"
# -> KC-SERVICES: Realm 'quorum' imported
```

Start the API. Outside the compose network Keycloak is reachable at `localhost:8081`, so the issuer
must be the public one:

```bash
pnpm --filter @quorum/server run build
OIDC_ISSUER_URL=http://localhost:8081/realms/quorum \
OIDC_AUDIENCE=quorum-api \
DATABASE_URL=postgres://quorum:<password>@localhost:5432/quorum \
S3_ENDPOINT=http://localhost:9000 S3_BUCKET=recordings \
S3_ACCESS_KEY=quorum-admin S3_SECRET_KEY=<password> \
  pnpm --filter @quorum/server run start
```

Health endpoint — public, no token:

```bash
curl -s localhost:8080/healthz
# {"status":"ok","service":"quorum-server"}
```

Protected endpoint without a token:

```bash
curl -s localhost:8080/api/me
# {"error":"missing_token","message":"The Authorization header is missing."}
```

Fetch a token for a dev user. The `quorum-dev-cli` client exists purely for this and is
**development only** — the PWA uses Authorization Code + PKCE against `quorum-pwa`, which rejects a
request without `code_challenge`:

```bash
TOKEN=$(curl -s -X POST \
  http://localhost:8081/realms/quorum/protocol/openid-connect/token \
  -d grant_type=password \
  -d client_id=quorum-dev-cli \
  -d username=dev.alice \
  -d password=dev-password | jq -r .access_token)
```

Call the protected endpoint:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/api/me
# {"userId":"259efb13-…","tenantId":"tenant-acme","roles":["quorum-admin","quorum-user"],
#  "username":"dev.alice","email":"alice@acme.dev.invalid"}
```

Tamper with the token and it is rejected:

```bash
curl -s -H "Authorization: Bearer ${TOKEN}x" localhost:8080/api/me
# {"error":"invalid_token","message":"The access token could not be verified."}
```

`dev.carol` lives in `tenant-globex` while `dev.alice` and `dev.bob` share `tenant-acme` — that is
the fixture for cross-tenant denial checks.
