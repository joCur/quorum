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

## 1. Download the deployment bundle

Every release carries a `quorum-deploy-<version>.tar.gz` asset: the compose file, the preflight
scripts, the production realm, the monitoring configuration and a copy of this guide. It is about
30 KB and it is everything a deployment needs.

```bash
VERSION=1.0.0
curl -fsSLO https://github.com/joCur/quorum/releases/download/v${VERSION}/quorum-deploy-${VERSION}.tar.gz
tar -xzf quorum-deploy-${VERSION}.tar.gz
cd quorum-deploy-${VERSION}
```

**There is no source code here, and no git checkout on the deploy host.** The application comes
from the published images and is never built on this machine.

The bundle's `.env.example` already pins `QUORUM_VERSION` to the version you downloaded, so the
configuration files and the images they run cannot drift apart. That is the reason the artifact is
one archive rather than a handful of files fetched individually: the pieces are only correct
together.

## 2. Write the .env file

```bash
cp .env.example .env
```

The release section at the bottom of `.env.example` lists every variable the release stack reads.
These are **mandatory** — the `preflight` service refuses to start the stack while any of them is
missing or still holds a placeholder:

| Variable                  | What it is                                                          |
| ------------------------- | ------------------------------------------------------------------- |
| `QUORUM_VERSION`          | Already set by the bundle to the version you downloaded. Leave it.   |
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
list of exactly which values and why, and nothing else starts. Once Keycloak is healthy, the
`keycloak-config` service applies the production realm (step 5) and the API waits for it.

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

The PWA's static files are in the bundle, in `client/`. Serve that directory from the app virtual
host — nothing to build, no toolchain on this machine. It is a single-page app, so unknown paths
fall back to `client/index.html`.

## 5. The realm is applied for you

**The committed `infra/keycloak/realm-quorum.json` is a development fixture and is deliberately
not imported by the release stack.** It sets `sslRequired: none`, ships a password-grant client
and three users with published passwords. Importing it into a deployment would hand anyone who
has read this repository a working login.

The production realm is `infra/keycloak/realm-production.json`, and you do not import it by hand.
The `keycloak-config` service applies it on every `up`, using
[keycloak-config-cli](https://github.com/adorsys/keycloak-config-cli): it compares the file
against the live realm and makes the realm match. It ran as part of step 3, and the API waits for
it to finish before starting, because the API validates tokens against that realm.

The file carries `$(env:QUORUM_PUBLIC_URL)` for the PWA client's redirect URIs and web origins, so
one committed file serves every deployment; the value comes from your `.env`.

### Realm changes are pull requests, not clicks

This is the part worth internalising:

- **To change the realm, change the file** and deploy. Session lifetimes, clients, mappers, roles,
  the password policy — all of it is reviewed as a diff, like any other change.
- **Configuration drift is reverted, not merged.** A setting changed by hand in the admin console
  survives until the next deploy, and then goes back to what the file says. That is the feature,
  not a limitation: it is what makes the file an accurate description of every environment rather
  than a hopeful one. (This is why the service runs with `IMPORT_CACHE_ENABLED=false`. By default
  the tool remembers a checksum of the file it last applied and skips the run when the file has
  not changed — which would leave hand edits in place indefinitely. Reconciling every time costs
  about three seconds.)
- **Users are the one exception.** The service runs with `IMPORT_MANAGED_USER=no-delete`, because
  users are runtime data rather than configuration — without it, every deploy would delete every
  account the deployment had ever created.

So do not make realm changes in the admin console expecting them to last. Accounts, group
memberships and role assignments are fine; realm and client configuration is not.

### The one thing you still do by hand

In the admin console at `KEYCLOAK_PUBLIC_URL` (sign in with `KEYCLOAK_ADMIN` and
`KEYCLOAK_ADMIN_PASSWORD`), **create your first user** in the `quorum` realm. Give them the
`quorum-user` role, plus `quorum-admin` for a tenant administrator, and set the `tenant_id`
attribute — every data object in Quorum is tenant-scoped (ADR-001), and a user without that
attribute gets tokens the API rejects.

Keep the `KEYCLOAK_ADMIN_PASSWORD` in `.env` working: it is not only a bootstrap credential any
more, it is what `keycloak-config` authenticates with on every deploy. Treat it as a deployment
credential. If you would rather deploys did not use the top-level admin, create a dedicated
service account with realm-management rights and point `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD`
at it.

## 6. Check it works

```bash
docker compose -f docker-compose.release.yml ps
```

Every long-running service should read `healthy`; `preflight`, `kms-preflight`, `minio-init` and
`keycloak-config` should have exited 0. If `keycloak-config` exited non-zero, its log names the
realm setting it could not apply, and the API will not have started. Then sign in through the PWA and record a short meeting: that exercises the
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

Download the next bundle and carry your `.env` across. Do not raise `QUORUM_VERSION` in an old
bundle: the compose file, the preflight scripts and the realm are versioned with the images, and
the whole point of the bundle is that they move together.

```bash
VERSION=1.1.0
curl -fsSLO https://github.com/joCur/quorum/releases/download/v${VERSION}/quorum-deploy-${VERSION}.tar.gz
tar -xzf quorum-deploy-${VERSION}.tar.gz
cp .env ../quorum-deploy-${VERSION}/.env          # from the directory you are running today
cd ../quorum-deploy-${VERSION}
```

Then compare your `.env` against the new `.env.example` for variables that were added or renamed,
set `QUORUM_VERSION` to the new version, and bring it up:

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d --wait
```

The volumes are named after the Compose project, not the directory, so the database and the
recordings follow the upgrade rather than being left behind.

Take a database backup first. Read the release notes for the versions you are skipping — a
release that changes the database schema says so there. Any realm change in the new version is
applied automatically, because `keycloak-config` runs on every `up`.

> **Keycloak and keycloak-config-cli are upgraded as a pair.** The `keycloak-config` image tag is
> `<config-cli version>-<keycloak version>`, e.g. `6.5.1-26.5.5`, because each config-cli build
> targets one Keycloak admin API. Raising `KEYCLOAK_VERSION` without raising
> `KEYCLOAK_CONFIG_CLI_VERSION` to a build made for it pairs the tool with an API it was not built
> against, and the realm apply is where you find out. Bump both tags in the same change.

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
| Keycloak password policy, MFA, brute-force tuning, federation | `infra/keycloak/realm-production.json` — configure them there, not in the admin console, or the next deploy reverts them. The realm ships Keycloak's brute-force protection on |
| Anything at all about a second host — this is a single-host deployment | Not in scope for this release                                      |

## When something is wrong

`docs/runbooks/pipeline.md` covers the pipeline itself: what each alert means, retry and
dead-letter semantics per job type, and how to redrive a dead-lettered job.
`docs/runbooks/backup-restore.md` covers losing data. For a stack that will not start, the
preflight output is the first thing to read — it names the variable and says what is wrong with
it.
