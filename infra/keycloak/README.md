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
| Dev users                          | See below.                                                                                        |

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
denial testable in the end-to-end auth suite.

## The production realm is a different file

This file is the **development** realm, imported by `docker-compose.yml` on first start. It is
not used anywhere else, and it must not be: `sslRequired: none`, a password-grant client and
three users with committed passwords.

Production uses `realm-production.json` in this directory. It is the same realm with four
differences and no others — `sslRequired: external`, no `quorum-dev-cli` client, no `dev.*`
users, and the PWA client's redirect URIs and web origins taken from `$(env:QUORUM_PUBLIC_URL)`
instead of `localhost`. Session lifetimes, refresh-token rotation, the audience and tenant
mappers and the realm roles are identical, because those are decisions rather than development
conveniences.

That file is applied by the `keycloak-config` service in `docker-compose.release.yml` on every
deploy, using [keycloak-config-cli](https://github.com/adorsys/keycloak-config-cli). It is
declarative and idempotent: the tool makes the live realm match the file, so a second run with an
unchanged file is a no-op, and a setting changed by hand in the admin console is reverted on the
next deploy. **Realm changes in production are pull requests against `realm-production.json`.**

The one exception is users: the service runs with `IMPORT_MANAGED_USER=no-delete`, because users
are runtime data rather than configuration. Everything else absent from the file is removed from
the realm.

Keep the two files in step when you change either. A change here that belongs in production
belongs in `realm-production.json` too — they are deliberately not generated from one another, so
that a development-only convenience cannot leak into production by construction, but that also
means nothing warns you when you update only one.

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
