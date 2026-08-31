# Keycloak — realm as code

The `quorum` realm lives in `realm-quorum.json` and is imported by the `keycloak` service on
startup (`start-dev --import-realm`). A fresh checkout plus `docker compose up` therefore yields a
working login without a single click in the admin console (ADR-006 §7).

## What the realm contains

| Object                            | Purpose                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Realm `quorum`                     | Short access tokens with long sessions — see "Session lifetimes" below.                          |
| Protocol mappers on each client    | Add the `quorum-api` audience and the `tenant_id` claim to the access token.                      |
| Client `quorum-pwa`                | Public browser client, Authorization Code + PKCE (S256) enforced. No secret, no direct grants.    |
| Client `quorum-dev-cli`            | **Development only** — password grant so a developer can fetch a token with one `curl`.           |
| Realm roles `quorum-user`, `quorum-admin` | Regular user vs. tenant administrator.                                                     |
| User profile attribute `tenant_id` | Declared attribute so the tenant claim survives Keycloak's declarative user profile.              |
| `smtpServer`                       | Where account mail goes — mailpit in development, the operator's relay in production. See below.   |
| Client `quorum-provisioner`        | Service account the API uses to give a self-registered account a tenant. See "Signing up" below.   |
| Dev users                          | See below.                                                                                        |

## Signing up

Self-registration is the way in: `registrationAllowed` with `verifyEmail`, so an account is created
by the person who will use it and is not usable until the address is proven. Both follow the mail
switch in production for the reason above — an account that can be registered but never verified is
worse than one that cannot be registered at all.

Two things a new account needs beyond a password.

**The role** comes from the realm's default roles. `quorum-user` is listed in `defaultRoles`, so
Keycloak grants it at registration with no code involved. That is the whole mechanism.

**The tenant cannot work that way**, and this is the part worth reading before changing anything.

Every data object in Quorum is tenant-scoped from day one (ADR-001), and the access token has to
carry the tenant as a claim: a request whose token has none is refused with 403 rather than falling
back to something global. Registration therefore produces a user Keycloak is perfectly happy with
and the API cannot serve — the account exists, the password works, the token is signed, and every
endpoint says no.

Keycloak cannot close that gap on its own. The declarative user profile has no defaults; a protocol
mapper reads attributes but cannot invent one; and two mappers writing the same claim have no
defined execution order, so "the attribute if present, else the user id" is not expressible. What
remains is a registration-time SPI in Java — a second language, its own build, pinned to an admin
API that changes between majors — or filling the attribute in from our own API. **We do the second
one.** On the first request a tenant-less account makes, the API writes a `tenant_id` attribute onto
the Keycloak user through the admin API, using the `quorum-provisioner` service account. The next
token carries the claim, and the account is then indistinguishable from one an administrator created
by hand.

The token contract does not change. `tenant_id` stays mandatory, an unprovisioned user still cannot
read a single row, and the one route that runs without a tenant is given an identity rather than a
request context — so it has no tenant to query under even if someone later added a query to it. See
`server/src/auth/provisioning.ts`.

The first tenant is `tenant-<user id>`: each self-registration gets its own. Deriving it rather than
generating a random one makes provisioning genuinely idempotent, so two devices signing in at the
same moment cannot produce two tenants for one account. It is a starting value and not an identity
— the attribute is ordinary data, so moving a user into a shared tenant later is an attribute change
and nothing else. That is also why this is an attribute rather than a mapper reading `sub` directly:
a mapper would make one-user-per-tenant permanent, and `quorum-admin` already promises tenants with
more than one member in them.

### The provisioner client

`quorum-provisioner` is confidential, has no browser flow and no direct grants — it can obtain a
token for itself and nothing else — and holds exactly two realm-management roles, `view-users` and
`manage-users`. Its secret is a committed development fixture in `realm-quorum.json` (like the dev
users) and `$(env:KEYCLOAK_PROVISIONER_SECRET)` in production, which the release preflight refuses
to let stay a placeholder.

Leaving `KEYCLOAK_PROVISIONER_SECRET` unset in a deployment switches the whole path off: the API
does not register the provisioning route at all, and an account without a tenant is simply refused.
That is the right behavior for a deployment whose users are created by an administrator.

### `tenant_id` is not a required user-profile attribute

It used to be. It cannot be: the person filling in the registration form has no edit permission on
it and nothing to write there, and a service account has no tenant at all. Requiring it in the user
profile makes both of those a special case for the sake of an invariant the API already enforces on
every single request.

## Mail

Keycloak is what sends password-reset and address-verification mail, so the relay is a realm
setting rather than an application one. The two realms answer that differently, and the difference
is the point.

**Development** sends everything to the `mailpit` container in `docker-compose.yml`. Nothing leaves
the machine, no credentials are involved, and every message is readable in the web inbox at
<http://localhost:8025> (`MAILPIT_UI_PORT`). That is what makes the reset flow something a developer
can walk end to end rather than only configure: click "Forgot Password?", open the inbox, follow the
link. It is also how the end-to-end suite reads a mail it has to act on.

**Production** takes the whole `smtpServer` block from the environment at import time — host, port,
sender, TLS flags and the relay credentials. There is no mail container in the release stack, and
there should not be: delivering mail from a fresh IP address is a job for a relay that has spent
years building a reputation.

These are not first-start-only settings. `keycloak-config-cli` reconciles the realm on every
deploy, so a changed `SMTP_*` value in `.env` — including the password — is written to the realm on
the next `up`, and an SMTP setting edited by hand in the admin console is reverted by that same run.
The admin API masks the stored password as `**********`, so reading it back through the console
tells you nothing about whether it changed; `realm_smtp_config` in Keycloak's own database is where
the actual value lives.

The development realm behaves differently on purpose, and the difference bites: `--import-realm`
imports a realm that does not exist yet and does nothing otherwise, so an edit to
`realm-quorum.json` needs Keycloak's state dropped as well. See "Changing the realm" below.

### Why `resetPasswordAllowed` is a substituted value

Password reset is only reachable through mail. A realm with reset enabled and no relay behind it
puts a "Forgot password?" link on the sign-in page that produces "you should receive an email
shortly" and then nothing at all — the user waits, retries, and concludes the account is broken.

So the production realm sets `resetPasswordAllowed` to `$(env:QUORUM_SMTP_ENABLED)`, the same switch
that makes the `SMTP_*` values mandatory in `scripts/secrets-preflight.sh`. One variable governs
both, and the two cannot disagree: a deployment either has a relay and offers the link, or has
neither. Turning mail on is a change to `.env` and a redeploy, not a change to this file.

Two alternatives were considered and rejected. A second production realm file (one with reset, one
without) doubles every future realm change and doubles the drift the guard below exists to catch. A
documented "run this `kcadm` command after deploying" is configuration that lives in a runbook
instead of in a reviewed file, and the next deploy reverts it — `keycloak-config-cli` runs with
`IMPORT_CACHE_ENABLED=false` precisely so that hand-made changes do not survive.

The value crosses from string to boolean on the way in: the substitution happens on the file text,
so the realm carries `"false"`, and Jackson coerces it to the boolean the representation declares.
That is verified behavior on the pinned `keycloak-config-cli` version, not an assumption — both
`true` and `false` were applied against a live Keycloak and read back from the admin API.

## Transport security: `sslRequired`

The realm sets `"sslRequired": "none"`, and that setting is the single clearest reason this file
must never be imported anywhere but a development machine.

Keycloak's default, `external`, demands HTTPS for every request that does not come from a local
address. In the compose stack the browser reaches Keycloak through Docker's port proxy over plain
HTTP, and the client address Keycloak sees is a bridge-network gateway — not a loopback address,
and therefore "external" as far as that check is concerned. The result is an intermittent
`HTTPS required` error on login: whether it happens depends on the network the container was given,
so it works on one machine and fails on the next. `none` turns the check off, and a fresh checkout
plus `docker compose up` logs in reliably over `http://localhost`.

**Production must run behind TLS with `sslRequired` set back to `external`.** Terminate TLS in the
reverse proxy, forward the protocol headers (`KC_PROXY_HEADERS=xforwarded`), and set `KC_HOSTNAME`
to the public HTTPS origin. Without that, passwords, tokens and the admin console travel in clear
text. The realm JSON here is a development fixture, not a production template — see "Before using
this realm outside development" below.

## Session lifetimes

Two different clocks are at work, and they are easy to confuse:

| Setting                  | Value           | In plain terms                                                                                                  |
| ------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `accessTokenLifespan`    | 5 minutes       | How long one access token is accepted by the API. The app swaps it for a fresh one in the background.             |
| `ssoSessionIdleTimeout`  | 14 days         | **Idle clock.** Reset every time the app refreshes. You are only signed out after not using Quorum for two weeks. |
| `ssoSessionMaxLifespan`  | 30 days         | **Absolute clock.** Runs regardless of activity: after 30 days you log in again even with daily use.              |
| `revokeRefreshToken` + `refreshTokenMaxReuse: 0` | on / 0 | Every refresh issues a new refresh token and invalidates the old one; replaying an old one kills the session.     |

So the answer to "am I always logged out after N hours of not using the app?" is: the idle clock is
what does that, and it is 14 days. A returning user who opens Quorum within two weeks is still
signed in; someone using it daily re-authenticates once a month.

The remember-me variants (`ssoSessionIdleTimeoutRememberMe`, `ssoSessionMaxLifespanRememberMe`) are
set to the same values, so ticking "remember me" does not silently create a longer-lived session
than the defaults.

The short access token is what makes this safe: the long-lived thing is a session that Keycloak can
revoke centrally, not a bearer token floating around. Revoking a session or disabling a user takes
effect within five minutes, because that is the longest an already-issued access token stays valid.
Rotation with reuse detection means a stolen refresh token is usable at most once before the whole
session is torn down.

Shorter values are appropriate for a deployment with stricter requirements — that is a per-tenant
policy decision, not a code change: `accessTokenLifespan`, `ssoSessionIdleTimeout` and
`ssoSessionMaxLifespan` in this file are the three knobs.

## Dev-only test users

**These credentials are development fixtures. They are deliberately committed, they are not
secrets, and the realm must never be imported as-is into a non-development environment.**

| Username     | Password       | `tenant_id`     | Realm roles                 |
| ------------ | -------------- | --------------- | --------------------------- |
| `dev.alice`  | `dev-password` | `tenant-acme`   | `quorum-user`, `quorum-admin` |
| `dev.bob`    | `dev-password` | `tenant-acme`   | `quorum-user`               |
| `dev.carol`  | `dev-password` | `tenant-globex` | `quorum-user`, `quorum-admin` |

Alice and Bob share a tenant; Carol is in a second one. That is what makes cross-tenant access
denial testable in the end-to-end auth suite — and it is why the tenant is a user attribute rather
than something derived from the user id: two people in one tenant has to remain expressible.

The development realm also carries the `quorum-provisioner` secret as a literal, for the same
reason these passwords are here: a fresh checkout should register a new account and land in a
working workspace without anyone setting a variable first.

## The production realm is a different file

This file is the **development** realm, imported by `docker-compose.yml` on first start. It is
not used anywhere else, and it must not be: `sslRequired: none`, a password-grant client and
three users with committed passwords.

Production uses `realm-production.json` in this directory. It is the same realm with a short list of
differences and no others — `sslRequired: external`, no `quorum-dev-cli` client, no `dev.*` human
users, the PWA client's redirect URIs, **post-logout redirect URIs** and web origins taken from
`$(env:QUORUM_PUBLIC_URL)` instead of `localhost`, the `smtpServer` block taken from the `SMTP_*`
environment instead of pointing at mailpit, the `quorum-provisioner` secret from
`$(env:KEYCLOAK_PROVISIONER_SECRET)` instead of the committed fixture, and `resetPasswordAllowed`,
`registrationAllowed` and `verifyEmail` following `$(env:QUORUM_SMTP_ENABLED)` instead of being on
unconditionally. Each of those is an allow-list rule with a reason. All three URI lists matter:
sign-out sends the browser back to the app's origin, and Keycloak refuses a post-logout redirect
the client has not declared. Session lifetimes, refresh-token rotation, the audience and tenant
mappers and the realm roles are identical, because those are decisions rather than development
conveniences.

That file is applied by the `keycloak-config` service in `docker-compose.release.yml` on every
deploy, using [keycloak-config-cli](https://github.com/adorsys/keycloak-config-cli). It is
declarative and idempotent: the tool makes the live realm match the file, so a second run with an
unchanged file is a no-op, and a setting changed by hand in the admin console is reverted on the
next deploy. **Realm changes in production are pull requests against `realm-production.json`.**

The one exception is users: the service runs with `IMPORT_MANAGED_USER=no-delete`, because users
are runtime data rather than configuration. Everything else absent from the file is removed from
the realm. The production realm's `users` array therefore holds exactly one entry — the
`quorum-provisioner` service account and its two realm-management roles, which are configuration
wearing a user's clothes. Real accounts come from sign-ups and are never written here.

Keep the two files in step when you change either. A change here that belongs in production
belongs in `realm-production.json` too — they are deliberately not generated from one another, so
that a development-only convenience cannot leak into production by construction, but that also
means nothing warns you when you update only one.

## Keeping the two realm files in step

Once a production realm file (`realm-production.json`) exists next to the development one, the two
are derived from each other by hand, and hand-derived files rot. A stale post-logout redirect list
survived in the production realm until someone happened to read both files side by side; nothing
would have caught it before sign-out broke on the first deployment that used that file. A protocol
mapper added to one file and forgotten in the other is the same bug wearing a different hat, and it
only shows up as a broken login in the environment nobody happens to be testing.

`pnpm run check:realm-drift` compares them, and CI runs it in the fast checks job. It normalizes
both files — dropping generated identifiers, keying clients, users, roles and protocol mappers by
name so ordering and position stop mattering, sorting the rest — and then requires every remaining
difference to be claimed by a rule in `realm-diff-allowlist.json`. Anything unclaimed fails with a
diff of the two normalized realms with the claimed differences left out, so the failure output shows
the drift and nothing else.

The check is inert while only one realm file exists: it prints a skip notice and exits successfully,
and arms itself the moment the second file appears. It is a separate root script rather than part of
`pnpm run lint`, because linting is about how source is written and this is a semantic invariant
between two configuration files — a distinct failure that deserves its own line in the CI log.

### The allow-list

Each entry in `realm-diff-allowlist.json` needs a `reason`; the guard only cares about `kind` and
`path`, but the reason is why the next reader can tell an intended difference from an old one.
Paths are `/`-separated and address the *normalized* realm, so a client is `clients/quorum-pwa`
rather than an array index.

| `kind`            | Allows                                                                       |
| ----------------- | ---------------------------------------------------------------------------- |
| `devOnly`         | The subtree at `path` exists only in the development realm.                    |
| `productionOnly`  | The mirror image — the subtree exists only in production.                      |
| `fixedValues`     | One leaf that differs, pinned to the exact `dev` and `production` values.       |
| `envSubstitution` | Every string under `path` is a literal in development and an import-time `$(env:…)` substitution in production. The guard checks that shape on both sides, so a hard-coded production origin fails even though the path is allowed. |

`volatileFields` lists the keys dropped before comparing — the generated identifiers and timestamps
Keycloak writes back on export, which carry no intent and would otherwise make every re-export look
like drift.

Two properties are worth knowing about. A rule may only excuse the difference it was written for: a
`devOnly` rule does not cover a value that differs on both sides, and a `fixedValues` rule stops
matching the moment either side changes. And a rule that no longer matches anything is itself a
failure — a stale allow-list entry is how a guard quietly stops guarding, so the check asks for it to
be deleted.

When a realm change is genuinely meant to land in only one environment, add the rule together with
the change and say why here. When it is not, the fix is to make the same edit in both files.

## Changing the realm

The audience and tenant mappers are attached to each client rather than to a shared client scope on
purpose: a realm JSON that declares a top-level `clientScopes` array replaces Keycloak's built-in
scopes instead of adding to them, which silently drops `sub`, `preferred_username`, `email` and
`realm_access` from the access token. Per-client mappers cost a little duplication and keep the
built-in scopes intact.

Realm changes are reviewed as diffs on this file, never clicked into a running instance. To pick up
an edit locally:

```bash
docker compose down keycloak
docker compose up -d keycloak
```

`--import-realm` only imports a realm that does not exist yet. To force a re-import after an edit,
drop Keycloak's state as well:

```bash
docker compose down -v keycloak   # or: drop and recreate the keycloak database
```

If you ever need to export the realm from a running container (for example to capture a change you
made in the admin console before hand-merging it back into this file):

```bash
docker compose exec keycloak \
  /opt/keycloak/bin/kc.sh export --realm quorum --file /tmp/realm-quorum.json
docker compose cp keycloak:/tmp/realm-quorum.json ./infra/keycloak/realm-quorum.json
```

Review such an export carefully — Keycloak writes back generated IDs and defaults that add a lot of
diff noise.
