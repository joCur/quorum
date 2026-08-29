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

### Where the recording scope comes from

The recording plugin never derives a tenant itself; it asks a `RecordingContextProvider`.

- **`JwtRecordingContextProvider`** (default) takes `tenantId`/`userId` from the validated access
  token and ignores every header. This is what runs in production.
- **`HeaderRecordingContextProvider`** reads `x-quorum-tenant-id` / `x-quorum-user-id` and exists
  only for local development. It is inert unless `RECORDING_ALLOW_HEADER_AUTH=true`, and that flag
  additionally marks the upgrade public so the header values are actually reachable. Never set it
  outside a developer machine — it lets any caller claim any tenant.

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
```

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
