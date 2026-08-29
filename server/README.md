# @quorum/server

Fastify API server. Currently contains the WebSocket recording endpoint (ADR-002, issue #4).

## Recording endpoint

`GET /ws/recording` (WebSocket). The wire protocol is defined by `shared/src/recording-protocol.ts` and is not extended here.

1. `session.start` → the server validates the announced audio format, writes `session.json` to object storage and answers `session.ready` with the session id.
2. Binary chunk frames (`[16 B session UUID][4 B seq][8 B timestampOffset][payload]`) are written to object storage; a `chunk.ack` with `persistedSeq` is sent **only after a successful write**. `persistedSeq` is the highest sequence number for which every chunk from 0 up is persisted, so the client may drop its IndexedDB buffer up to that point.
3. `session.pause` / `session.resume` record wall-clock marks. A `session.resume` on a fresh connection is also the **reconnect** path: session state is rebuilt from a prefix listing in object storage and answered with a `chunk.ack`, so a client can continue after the server was killed mid-recording.
4. `session.end` writes `manifest.json`, enqueues a `transcribe` job via pg-boss and answers `session.finalized`. If chunks are still missing (`lastSeq > persistedSeq`) the session is not finalized and the server re-acknowledges instead.

The protocol has no error message type, so failures are reported through WebSocket close codes: 1002 protocol error, 1008 policy violation (format, scope, unauthorized), 1009 chunk too large, 1011 internal error.

### Validation

- The announced format must be one of WebM/Opus, Ogg/Opus or MP4/AAC (`src/recording/audio-format.ts`).
- The first chunk must carry the matching container magic bytes — this is not a generic blob upload.
- Per-chunk payload limit: 1 MiB; `@fastify/websocket` enforces the same limit at the transport level.
- Sequence numbers more than 1024 ahead of `persistedSeq` are refused.
- Duplicate and out-of-order sequence numbers are handled idempotently.

## Storage layout (ADR-001 tenant/user scoping)

```
tenants/<tenantId>/users/<userId>/sessions/<sessionId>/session.json
tenants/<tenantId>/users/<userId>/sessions/<sessionId>/chunks/<seq:010d>.bin
tenants/<tenantId>/users/<userId>/sessions/<sessionId>/manifest.json
```

One object per chunk instead of a multipart upload: the key is a pure function of the sequence number, which makes re-sends idempotent overwrites and lets the server rebuild `persistedSeq` from a prefix listing after a crash. Concatenating the chunks into a single audio object is the worker's job (#6), driven by the manifest.

## Encryption at rest

`scripts/minio-init.sh` runs as the `minio-init` one-shot service, creates the bucket and enables **default SSE-S3** on it, so an object cannot be written unencrypted. This requires MinIO's built-in KMS: set `MINIO_KMS_SECRET_KEY=<key-name>:<base64 32 bytes>` in `.env` (see `.env.example`) — back that key up, without it the stored audio is unreadable. The server additionally sends `S3_SSE` (default `AES256`) with every write.

## Auth

Until the JWT auth plugin from #3 lands, the tenant/user scope comes from `RecordingContextProvider`. The development implementation reads `x-quorum-tenant-id` / `x-quorum-user-id` headers and refuses to work unless `RECORDING_ALLOW_HEADER_AUTH=true`. Swapping in the real provider is one argument in `buildServer`.

## Tests

```
pnpm test                       # unit + protocol conformance, in-memory adapters
QUORUM_INTEGRATION=1 pnpm vitest run server/test/integration.test.ts
```

The integration suite is opt-in and needs a running MinIO (with the bucket bootstrapped) and Postgres; it verifies that chunks land encrypted at rest and that a `transcribe` job is fetchable from pg-boss.
