# Deploying Quorum

How to bring a Quorum release up on a fresh host, using the published images and
`docker-compose.release.yml`.

This is the deployment guide, not the development setup — for that, see the README. The two use
different compose files on purpose: `docker-compose.yml` builds from the working tree, publishes
ports for convenience and imports a development realm with committed test passwords. None of that
belongs on a host anyone else can reach.

## What this stack is, and what is around it

Everything Quorum needs runs in one Compose project on one host: the API, the transcription
worker, Whisper, Keycloak, Postgres and MinIO. Two things stay outside it and are your
responsibility:

- **A TLS-terminating reverse proxy.** Nothing in the stack speaks HTTPS. The API and Keycloak
  listen on plain HTTP bound to `127.0.0.1`, so without a proxy in front they are unreachable from
  anywhere but the host itself. That is deliberate.
- **The PWA's static files.** The browser app is a static build, not a container. The reverse
  proxy serves it.

## Prerequisites

- A Linux host with Docker Engine and the Compose plugin.
- A domain with two names pointing at it — one for the app, one for Keycloak — and certificates
  for both. Caddy or Traefik will obtain them for you; the stack does not care which proxy you
  use.
- For GPU transcription: NVIDIA drivers and the NVIDIA container toolkit. Without them Whisper
  runs on the CPU, which is slower but works.
- `jq`, for the realm derivation step below.

## 1. Get the release

```bash
git clone --branch v1.0.0 https://github.com/joCur/quorum.git
cd quorum
```

The checkout is for the compose file, the preflight scripts and the Prometheus and Grafana
configuration — the application itself comes from the published images and is never built here.
Check out the tag matching the version you intend to run, so the compose file and the images agree.

## 2. Write the .env file

```bash
cp .env.example .env
```

The release section at the bottom of `.env.example` lists every variable the release stack reads.
These are **mandatory** — the `preflight` service refuses to start the stack while any of them is
missing or still holds a placeholder:

| Variable                  | What it is                                                          |
| ------------------------- | ------------------------------------------------------------------- |
| `QUORUM_VERSION`          | The release to run, e.g. `1.0.0`. Pinned; never `latest`.            |
| `QUORUM_PUBLIC_URL`       | The app origin browsers use. Must be `https://`, not loopback.       |
| `KEYCLOAK_PUBLIC_URL`     | The Keycloak origin. Must be `https://`, not loopback.               |
| `POSTGRES_USER` / `_DB`   | Database role and database name.                                     |
| `POSTGRES_PASSWORD`       | See the warning below about URL-safe characters.                     |
| `KEYCLOAK_DB_PASSWORD`    | Keycloak's own database role on the same Postgres instance.          |
| `KEYCLOAK_ADMIN_PASSWORD` | The bootstrap admin. Used once, in step 5.                           |
| `MINIO_ROOT_USER` / `_PASSWORD` | Object storage credentials, also used as the S3 access key.    |
| `MINIO_KMS_SECRET_KEY`    | Storage encryption master key. **Back this up — see step 7.**        |
| `S3_BUCKET`               | Bucket for recordings, e.g. `recordings`.                            |
| `SUMMARY_BASE_URL` / `_API_KEY` / `_MODEL` | The OpenAI-compatible summary backend (ADR-005).    |

Generate each password separately:

```bash
openssl rand -hex 24
```

> **Use hex, not base64, at least for `POSTGRES_PASSWORD`.** It is embedded in the `DATABASE_URL`
> the compose file assembles, and a `/` or `@` — which `openssl rand -base64` produces about half
> the time — silently truncates that URL. The API and the worker then crash-loop with
> `ENOTFOUND` naming something that looks nothing like a password. The preflight rejects such a
> value rather than letting you find out the hard way.

The storage encryption key has its own format:

```bash
echo "quorum-key:$(openssl rand -base64 32)"
```

Then lock the file down — it holds every credential in the deployment:

```bash
chmod 600 .env
```

## 3. Start the stack

```bash
docker compose -f docker-compose.release.yml up -d --wait
```

With a GPU for transcription:

```bash
docker compose -f docker-compose.release.yml -f docker-compose.gpu.yml up -d --wait
```

The preflights run first. If anything is missing or still a placeholder, the stack stops with a
list of exactly which values and why, and nothing else starts.

When it comes up, the API is on `127.0.0.1:8080` and Keycloak on `127.0.0.1:8081`. Postgres, the
MinIO S3 API and the MinIO console are not published at all — the only way to them is the Compose
network. Change `BIND_ADDRESS` only if your proxy runs somewhere other than this host, and
understand that it publishes plain HTTP when you do.

## 4. Put the reverse proxy in front

Two virtual hosts, both terminating TLS:

| Public name                        | Proxies to                | Also needs                                    |
| ---------------------------------- | ------------------------- | --------------------------------------------- |
| `QUORUM_PUBLIC_URL`, e.g. `quorum.example.com` | `127.0.0.1:8080` for `/api` and the recording WebSocket; the built PWA files for everything else | WebSocket upgrade headers passed through |
| `KEYCLOAK_PUBLIC_URL`, e.g. `auth.example.com` | `127.0.0.1:8081`      | `X-Forwarded-Proto` and `X-Forwarded-For` set  |

The forwarded headers are not optional. Keycloak runs with `KC_PROXY_HEADERS=xforwarded`, and the
realm requires HTTPS (`sslRequired: external`). Without those headers Keycloak sees plain HTTP,
decides the request is insecure, and every login fails.

The recording endpoint is a long-lived WebSocket that streams audio for the length of a meeting.
Raise your proxy's read timeout accordingly — an hour-long recording behind a 60-second idle
timeout reconnects constantly.

Build the PWA and serve the output directory from the app virtual host:

```bash
pnpm install --frozen-lockfile
pnpm --filter @quorum/client run build   # writes client/dist
```

## 5. Create the production realm

**The committed `infra/keycloak/realm-quorum.json` is a development fixture and is deliberately
not imported by the release stack.** It sets `sslRequired: none`, ships a password-grant client
and three users with published passwords. Importing it into a deployment would hand anyone who
has read this repository a working login.

The supported path is to derive a production realm from it, so the two cannot drift apart in the
parts that matter:

```bash
./scripts/keycloak-production-realm.sh https://quorum.example.com > realm-production.json
```

That sets `sslRequired: external`, drops the `quorum-dev-cli` client, drops the three `dev.*`
users, and rewrites the PWA client's redirect URIs and web origins to your origin. Everything
else — session lifetimes, refresh token rotation, the audience and tenant mappers, the realm
roles — is carried over unchanged, because those are decisions rather than conveniences.

Import it once:

```bash
docker compose -f docker-compose.release.yml cp \
  realm-production.json keycloak:/tmp/realm-production.json
docker compose -f docker-compose.release.yml exec keycloak \
  /opt/keycloak/bin/kc.sh import --file /tmp/realm-production.json
docker compose -f docker-compose.release.yml restart keycloak
```

The compose file mounts no import directory, so this is a one-time action a container restart can
never repeat or undo. Realm changes after this point are made in the admin console — or by
re-importing with `--override true`, which replaces the realm and everything in it.

Then, in the admin console at `KEYCLOAK_PUBLIC_URL` (sign in with `KEYCLOAK_ADMIN` and
`KEYCLOAK_ADMIN_PASSWORD`):

1. **Create your first user** in the `quorum` realm. Give them the `quorum-user` role, plus
   `quorum-admin` for a tenant administrator, and set the `tenant_id` attribute — every data
   object in Quorum is tenant-scoped (ADR-001), and a user without that attribute gets tokens the
   API rejects.
2. **Replace the bootstrap admin.** `KC_BOOTSTRAP_ADMIN_*` creates a temporary admin in the
   `master` realm. Create a permanent admin account with its own password, then delete the
   bootstrap one.

## 6. Check it works

```bash
docker compose -f docker-compose.release.yml ps
```

Every long-running service should read `healthy`; `preflight`, `kms-preflight` and `minio-init`
should have exited 0. Then sign in through the PWA and record a short meeting: that exercises the
whole critical path — chunk streaming, persistence, transcription and summary — and is the only
check that covers all of it at once.

## 7. Before you call it done

- **Back up the `MINIO_KMS_SECRET_KEY`**, somewhere other than this host. Without it the stored
  audio is permanently unreadable — no support path, no recovery. The procedure is in
  `docs/runbooks/backup-restore.md`.
- **Set up backups** for Postgres and the MinIO bucket, per the same runbook.
- **Turn on monitoring** if you want alerts, which needs a Grafana admin password:

  ```bash
  docker compose -f docker-compose.release.yml --profile monitoring up -d
  ```

  See `docs/observability.md` and `docs/runbooks/pipeline.md`.

## Upgrading

```bash
git fetch --tags && git checkout v1.1.0     # compose file and scripts
# raise QUORUM_VERSION in .env to match
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d --wait
```

Take a database backup first. Read the release notes for the versions you are skipping — a
release that changes the database schema says so there.

## Security: what this stack does and does not do

The compose file is hardened where the images allow: every service runs with all Linux
capabilities dropped and `no-new-privileges`, and all of them but Keycloak run on a read-only root
filesystem. Keycloak is the exception — a read-only root filesystem leaves its transaction
recovery store uncreatable, and it then runs degraded — so the flag is off there and the reason is
written next to it in the compose file. Whisper is a third-party image and gets resource limits
only; it holds no credentials and has no route to the database or the object store. Every service
has a memory and CPU limit and rotating logs, so one misbehaving container cannot take the host
with it.

**Not covered by this stack, and still yours to do:**

| Not covered                       | Where to look                                                     |
| --------------------------------- | ------------------------------------------------------------------ |
| Host hardening — SSH, firewall, unattended upgrades, restricting who can reach the Docker socket | Your own baseline. Anyone in the `docker` group is root on this host. |
| TLS certificates and their renewal | Your reverse proxy                                                 |
| Backups: schedule, retention, restore drills, and the deletion window backups must honor | `docs/runbooks/backup-restore.md`                                  |
| Storage encryption key custody and rotation | `docs/runbooks/backup-restore.md`                                  |
| Alert routing — the stack raises alerts, it does not deliver them anywhere | `infra/monitoring/alertmanager.yml`, `docs/runbooks/pipeline.md`   |
| Disk capacity for recordings, and what happens when it runs out | `COST-MODEL.md` for the sizing, the storage quota variables for the limit |
| Keycloak password policy, MFA, brute-force tuning, federation | The admin console; the realm ships Keycloak's brute-force protection on |
| Anything at all about a second host — this is a single-host deployment | Not in scope for this release                                      |

## When something is wrong

`docs/runbooks/pipeline.md` covers the pipeline itself: what each alert means, retry and
dead-letter semantics per job type, and how to redrive a dead-lettered job.
`docs/runbooks/backup-restore.md` covers losing data. For a stack that will not start, the
preflight output is the first thing to read — it names the variable and says what is wrong with
it.
