# `@quorum/server`

Fastify API server. Today it contains the auth foundation from issue #3: a health endpoint, a
plugin that validates Keycloak-issued access tokens against the realm JWKS, and the tenant-scoped
request context every later handler builds on. The recording endpoint (ADR-002), persistence and
the job pipeline arrive in the follow-up tickets.

## The tenant/user scoping convention

ADR-001 requires tenant and user scope in **every** data object from day one. That is a convention
this package enforces rather than documents:

1. **Identity comes only from the validated token.** `request.requireContext()` returns a
   `RequestContext` with `userId` (the `sub` claim) and `tenantId` (the `tenant_id` claim). A
   tenant sent in a body, a query parameter or a header is attacker-controlled and is never read.
2. **A token without a tenant is rejected** with `403 missing_tenant`. There is no "global" or
   "default" tenant to fall back to — a request that cannot be scoped does not run.
3. **Authentication is default-deny.** The auth plugin installs one `onRequest` hook for the whole
   instance. A route is reachable without a token only if it declares `config: { public: true }` —
   currently just `/healthz`. Adding a route can therefore not accidentally leave it open; it can
   only be deliberately opened.
4. **Every table carries `tenant_id` and an owning `user_id`**, both `NOT NULL`, with the tenant
   column part of every index that serves a list query, and foreign keys pointing at tenant-scoped
   parents so the ADR-001 deletion cascade is enforced by the database rather than by application
   code.
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
| `SERVER_HOST`, `SERVER_PORT`, `LOG_LEVEL` | Listener and logging.                                          |

Keys are fetched from the realm JWKS lazily and cached by `jose`; a rotated signing key is picked
up on the next unknown `kid` without a restart.

## Tests

`pnpm test` from the repository root runs them (that is what CI runs too). The auth tests generate
an RSA key pair in-process and sign their own tokens, so they need neither a network nor a running
Keycloak, and they cover the valid case plus expired, wrong-issuer, wrong-audience, unknown-key,
`alg: none`, malformed-header and missing-tenant tokens.

## Manual verification — compose up, get a token, call a protected endpoint

Full E2E coverage of the login flows is issue #10. This is the short manual path.

```bash
cp .env.example .env      # then fill in the CHANGE_ME values
docker compose up -d postgres keycloak
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
the fixture the cross-tenant denial test of issue #10 will use.
