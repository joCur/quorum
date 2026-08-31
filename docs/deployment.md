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

- **A TLS-terminating reverse proxy.** Nothing in the stack speaks HTTPS. The stack publishes one
  plain-HTTP port bound to `127.0.0.1`, so without a proxy in front it is unreachable from
  anywhere but the host itself. That is deliberate — and because the stack's own edge proxy has
  already done the routing, yours only terminates TLS and forwards to that one port.

Everything else, the browser app included, is a service in the compose file.

## Prerequisites

- A Linux host with Docker Engine and the Compose plugin.
- A domain name pointing at it, and a certificate. Caddy or Traefik will obtain one for you; the
  stack does not care which proxy you use. One name is enough: the app, the API and Keycloak all
  live on it.
- For GPU transcription: NVIDIA drivers and the NVIDIA container toolkit. Without them Whisper
  runs on the CPU, which is slower but works.

## 1. Get the two files

```bash
curl -fsSLO https://raw.githubusercontent.com/joCur/quorum/main/docker-compose.release.yml
curl -fsSL  https://raw.githubusercontent.com/joCur/quorum/main/.env.example -o .env
```

For a GPU machine, take `docker-compose.release-gpu.yml` instead. The two files are complete
alternatives — pick one, never both, and never chain them with `-f`. Both are also attached to
every GitHub release if you would rather take them from a specific version.

That is everything you download. There is no repository to clone and nothing to unpack: every
script, every configuration file and the production realm are baked into the images.

## 2. Fill in the .env

Open `.env` and set the values under "Release deployment". They are **mandatory** — the stack
refuses to start while any of them is missing or still holds a placeholder, and tells you which:

| Variable                  | What it is                                                          |
| ------------------------- | ------------------------------------------------------------------- |
| `QUORUM_PUBLIC_URL`       | The origin browsers use. Must be `https://`, not loopback.           |
| `KEYCLOAK_PUBLIC_URL`     | The same origin — Keycloak is served under `/realms` on that host.   |
| `POSTGRES_USER` / `_DB`   | Database role and database name.                                     |
| `POSTGRES_PASSWORD`       | See the warning below about URL-safe characters.                     |
| `KEYCLOAK_DB_PASSWORD`    | Keycloak's own database role on the same Postgres instance.          |
| `KEYCLOAK_ADMIN_PASSWORD` | The admin account. Used on every deploy, not just the first.         |
| `MINIO_ROOT_USER` / `_PASSWORD` | Object storage credentials, also used as the S3 access key.    |
| `MINIO_KMS_SECRET_KEY`    | Storage encryption master key. **Back this up — see step 6.**        |
| `S3_BUCKET`               | Bucket for recordings, e.g. `recordings`.                            |
| `SUMMARY_BASE_URL` / `_API_KEY` / `_MODEL` | The OpenAI-compatible summary backend (ADR-005).    |

Generate each password separately:

```bash
openssl rand -hex 24
```

> **Use hex, not base64, at least for `POSTGRES_PASSWORD`.** It is embedded in the `DATABASE_URL`
> the compose file assembles, and a `/` or `@` — which `openssl rand -base64` produces about half
> the time — silently truncates that URL. The API and the worker then crash-loop with
> `ENOTFOUND` naming something that looks nothing like a password. The stack rejects such a value
> rather than letting you find out the hard way.

The storage encryption key has its own format:

```bash
echo "quorum-key:$(openssl rand -base64 32)"
```

Then lock the file down — it holds every credential in the deployment:

```bash
chmod 600 .env
```

### Mail — optional, and off by default

The stack has no mail container and never sends anything until you point it at a relay of your own.
Off is a complete configuration: users sign in with the password they were given, and nothing in
the interface offers a mail that cannot arrive.

Turn it on with one switch and the settings it makes mandatory:

| Variable                  | What it is                                                             |
| ------------------------- | ---------------------------------------------------------------------- |
| `QUORUM_SMTP_ENABLED`     | `true` or `false`, exactly. The switch for the whole feature.           |
| `SMTP_HOST` / `SMTP_PORT` | Your relay. `587` with STARTTLS is the usual pair; `465` is implicit TLS. |
| `SMTP_FROM`               | Sender address. Your relay and your SPF record both have to allow it.    |
| `SMTP_FROM_DISPLAY_NAME`  | The name in the From line. Defaults to `Quorum`.                         |
| `SMTP_SSL` / `SMTP_STARTTLS` | Transport. Both `false` sends mail in the clear, and the preflight says so. |
| `SMTP_AUTH`               | Whether the relay wants credentials. When `true`, the two below are required. |
| `SMTP_USER` / `SMTP_PASSWORD` | The relay credentials.                                              |

`QUORUM_SMTP_ENABLED` does two things at once, and that is deliberate. It makes the `SMTP_*` values
mandatory in the preflight — a missing or placeholder relay password stops the deploy with one
readable line instead of producing reset mail that silently vanishes. And the realm substitutes the
same value into `resetPasswordAllowed`, so while mail is off the sign-in page shows no "Forgot
password?" link at all. A door that opens onto a mail nobody can send is worse than no door: the
user waits, retries, and concludes the account is broken.

Switching it on is a change to `.env` and a redeploy. The realm is reconciled on every start, so
the link appears on the next one.

### Which version you get

Images default to `latest`, so the stack runs the current release and `docker compose pull` moves
it forward. Set `QUORUM_VERSION` in `.env` to pin one instead — the honest trade-off is that
`latest` makes updating a single command while pinning makes the deployment reproducible.

## 3. Start it

```bash
docker compose -f docker-compose.release.yml up -d
```

The stack validates your configuration first and stops with a readable list if anything is
missing, then creates Keycloak's database, the recordings bucket and the production realm, and
brings everything up. All of that is idempotent and happens on every start.

**One port is published**: `127.0.0.1:8080`, the edge proxy. The app, the API and Keycloak are all
reachable through it, and none of them — nor Postgres, MinIO or the client — has a host port of
its own. Change `BIND_ADDRESS` only if your reverse proxy runs on another machine, and understand
that it publishes plain HTTP when you do.

The one exception is the opt-in `monitoring` profile: enabling it publishes Grafana, Prometheus
and Alertmanager on loopback as well, because those are human-facing UIs with nothing in front of
them. They stay off unless you ask for them.

## 4. Put your reverse proxy in front

**The stack publishes exactly one port**, and the edge proxy inside it has already done the
routing. Your proxy therefore has one job: terminate TLS and forward everything to that port, on
one hostname. There is no path-routing table for you to reproduce.

One virtual host, `QUORUM_PUBLIC_URL`, forwarding to `127.0.0.1:8080`.

Caddy, complete:

```caddyfile
quorum.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

That is the whole file. Caddy obtains the certificate, sets `X-Forwarded-Proto` and
`X-Forwarded-For`, and proxies WebSockets, all by default.

Nginx, complete:

```nginx
server {
    listen 443 ssl;
    server_name quorum.example.com;

    ssl_certificate     /etc/letsencrypt/live/quorum.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/quorum.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The recording endpoint is a WebSocket held open for the length of a meeting.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
```

Two details in there are not optional, and both fail in ways that do not point at the proxy:

- **`X-Forwarded-Proto`.** Keycloak runs with `KC_PROXY_HEADERS=xforwarded` behind a realm that
  requires HTTPS, and it only ever sees plain HTTP. Without this header it decides every request
  is insecure and every login fails.
- **The WebSocket upgrade and a long read timeout.** Recording streams audio for the length of a
  meeting. Behind a 60-second idle timeout it reconnects constantly.

Caddy does both without being asked, which is why its configuration is one line.

### Both public URLs are the same host

Set `KEYCLOAK_PUBLIC_URL` to the *same* origin as `QUORUM_PUBLIC_URL`. The edge serves Keycloak
under `/realms` on the app's own origin, so the issuer in every token is
`https://quorum.example.com/realms/quorum`. That is what lets the browser treat the app, the API
and the identity provider as one site — no CORS, no third-party cookies — and it is the shape the
published client image is built for.

The admin console is on that host too, at `/admin`.

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

### Creating the first user

Self-registration through the app is the intended path and is not built yet. Until it ships:
open the admin console at `QUORUM_PUBLIC_URL/admin`, sign in with `KEYCLOAK_ADMIN` and
`KEYCLOAK_ADMIN_PASSWORD`, and add a user to the `quorum` realm with the `quorum-user` role and a
`tenant_id` attribute (add `quorum-admin` for a tenant administrator). Every data object in Quorum
is tenant-scoped (ADR-001), so a user without that attribute gets tokens the API rejects.

`KEYCLOAK_ADMIN_PASSWORD` stays in use after the first start — it is what the bootstrap
authenticates with on every deploy, so treat it as a deployment credential rather than a one-time
one.

## 6. Check it works

```bash
docker compose -f docker-compose.release.yml ps
```

Every long-running service should read `healthy`, and the three `init-*` one-shots should have
exited 0. A quick check through the front door:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/            # the app
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz     # the API
curl -sS http://127.0.0.1:8080/realms/quorum/.well-known/openid-configuration | head -c 80
```

All three go through the edge, which is how the browser reaches them. If an `init-*` container
exited non-zero, its log says what it could not do, and the API will not have started.

Then sign in and record a short meeting. That exercises the whole critical path — chunk streaming,
persistence, transcription and summary — and is the only check that covers all of it at once.

## Where the data lives

Four named Docker volumes: `quorum_pg-data` (the database, including Keycloak's), `quorum_minio-data`
(the recordings), `quorum_whisper-models` (the model cache) and, with monitoring on, the Prometheus
and Grafana volumes. `docker volume ls` shows them; `docker compose down` leaves them alone, and
only `down -v` destroys them.

**Named volumes are the default deliberately.** They need no host directory to exist beforehand,
they carry no uid/gid mismatch between the container's user and yours — the failure mode of a bind
mount, and one that surfaces as a container that will not start rather than as a permissions
message — and they are portable across hosts with different filesystem layouts.

### Putting the data on a specific filesystem

If you want the recordings on a particular disk — a large array, an encrypted mount, a path your
existing backup tooling already watches — declare the volume with a bind driver. Add this to the
bottom of your compose file, replacing the `volumes:` entry of the same name:

```yaml
volumes:
  minio-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /srv/quorum/recordings   # must already exist
  pg-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /srv/quorum/postgres     # must already exist
```

Create the directories first. The containers run as non-root users, so the directories have to be
writable by them — this is the trap named above, and it is why this is the escape hatch rather
than the default. If a container fails to start after this change, ownership is the first thing to
check.

Do this before the first start if you can. Moving a volume afterwards means stopping the stack and
copying the contents across, not just changing the declaration.

### Backups do not read the volumes directly

Worth knowing before you plan around paths: the backup procedure does not copy volume directories.
It uses `pg_dump` per logical database — a snapshot of a running Postgres data directory is not a
consistent backup — and `mc mirror` against the MinIO API for the recordings. Both work identically
whether the volume is named or bound to a path, so relocating data does not change the backup
story. The full procedure, including the retention and deletion window, is in the
[backup and restore runbook](https://github.com/joCur/quorum/blob/main/docs/runbooks/backup-restore.md).

## 7. Before you call it done

- **Back up the `MINIO_KMS_SECRET_KEY`**, somewhere other than this host. Without it the stored
  audio is permanently unreadable — no support path, no recovery. The procedure is in the
  [backup and restore runbook](https://github.com/joCur/quorum/blob/main/docs/runbooks/backup-restore.md).
- **Set up backups** for Postgres and the MinIO bucket, per the same runbook.
- **Turn on monitoring** if you want alerts, which needs a Grafana admin password:

  ```bash
  docker compose -f docker-compose.release.yml --profile monitoring up -d
  ```

  See the [observability notes](https://github.com/joCur/quorum/blob/main/docs/observability.md)
  and the [pipeline runbook](https://github.com/joCur/quorum/blob/main/docs/runbooks/pipeline.md).

## Updating

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
```

That is the whole update. New images, and the bootstrap re-runs — so a realm change or a new
database migration in the release is applied on the way up, without you doing anything.

If you pinned `QUORUM_VERSION`, raise it first. Take a database backup before an update, and read
the release notes for the versions you are skipping: a release that changes the database schema
says so there.

Occasionally an update adds a service or changes the compose file itself. Re-download it the same
way you did the first time, next to your existing `.env`; your data lives in named volumes and is
not affected.

## Configuring the client image

The browser app is built by Vite, which bakes `VITE_*` values into the bundle at build time. A
published image therefore cannot carry your API origin or your issuer URL, and the image is built
for the shape everything else here assumes: **one origin**. `VITE_API_BASE_URL` is empty, so API
calls go to the origin the app was served from, and the OIDC issuer defaults to
`<that origin>/realms/quorum`. The edge proxy makes both true.

This was chosen over injecting a config file at container start, which would mean an app that
reads its configuration from a global written by an entrypoint, plus a window during startup when
that global is not there yet.

**If your deployment needs a different shape** — Keycloak on a separate public host, or the realm
under a different path — the published image will not do, and you build your own. It is one
command:

```bash
docker build -f client/Dockerfile \
  --build-arg VITE_OIDC_ISSUER_URL=https://auth.example.com/realms/quorum \
  -t my-registry/quorum-client:1.0.0 .
```

Then point `QUORUM_IMAGE_REGISTRY` at your registry, or override the `client` service's `image`.
The same applies to `VITE_API_BASE_URL` if the API is not on the app's origin, and to
`VITE_OIDC_ISSUER_PATH` if the realm is served under a different path on it.

## Security: what this stack does and does not do

The compose file is hardened where the images allow: every service runs with all Linux
capabilities dropped and `no-new-privileges`, and all of them but Keycloak run on a read-only root
filesystem — the edge proxy and the client included, both of which are unprivileged nginx serving
on a high port, so nothing had to be relaxed to make them start. Keycloak is the exception — a read-only root filesystem leaves its transaction
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
