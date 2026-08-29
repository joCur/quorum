# Keycloak — realm as code

The `quorum` realm lives in `realm-quorum.json` and is imported by the `keycloak` service on
startup (`start-dev --import-realm`). A fresh checkout plus `docker compose up` therefore yields a
working login without a single click in the admin console (ADR-006 §7, issue #3).

## What the realm contains

| Object                            | Purpose                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Realm `quorum`                     | Access tokens 5 min, SSO idle 30 min, SSO max 10 h, refresh-token rotation with reuse detection. |
| Protocol mappers on each client    | Add the `quorum-api` audience and the `tenant_id` claim to the access token.                      |
| Client `quorum-pwa`                | Public browser client, Authorization Code + PKCE (S256) enforced. No secret, no direct grants.    |
| Client `quorum-dev-cli`            | **Development only** — password grant so a developer can fetch a token with one `curl`.           |
| Realm roles `quorum-user`, `quorum-admin` | Regular user vs. tenant administrator.                                                     |
| User profile attribute `tenant_id` | Declared attribute so the tenant claim survives Keycloak's declarative user profile.              |
| Dev users                          | See below.                                                                                        |

## Dev-only test users

**These credentials are development fixtures. They are deliberately committed, they are not
secrets, and the realm must never be imported as-is into a non-development environment.**

| Username     | Password       | `tenant_id`     | Realm roles                 |
| ------------ | -------------- | --------------- | --------------------------- |
| `dev.alice`  | `dev-password` | `tenant-acme`   | `quorum-user`, `quorum-admin` |
| `dev.bob`    | `dev-password` | `tenant-acme`   | `quorum-user`               |
| `dev.carol`  | `dev-password` | `tenant-globex` | `quorum-user`, `quorum-admin` |

Alice and Bob share a tenant; Carol is in a second one. That is what makes cross-tenant access
denial testable (issue #10).

## Before using this realm outside development

1. Delete the `quorum-dev-cli` client and the three `dev.*` users.
2. Replace the `localhost` redirect URIs and web origins of `quorum-pwa` with the real origins.
3. Start Keycloak with `start` instead of `start-dev` (see the comments on the `keycloak` service
   in `docker-compose.yml`), behind TLS, with `KC_HOSTNAME` set to the public issuer origin.
4. Set a real `KEYCLOAK_ADMIN_PASSWORD`; the value in `.env.example` is a placeholder.

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
