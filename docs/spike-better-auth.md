# Spike: better-auth instead of Keycloak

**Status:** evaluation only — branch `spike-better-auth`, **not for merge**. ADR-006 §7 stands
until the PO decides otherwise; this document is the evidence for that decision, not a proposal
already acted on.

**Scope:** email and password only. Google and Entra were explicitly deferred by the PO; what
social login would cost in each world is assessed in §8 but not built. Password reset and email
verification were explicitly not to be built; §7 compares what each world needs there.

---

## 1. What was built, and what it proves

A working prototype: Keycloak is removed from the compose path entirely, and better-auth 1.7.2
runs inside the Fastify API. Everything the existing suites assert about authentication still
holds, and the suites were adapted rather than deleted.

### Test evidence

| Suite                                | Command                | Result                        |
| ------------------------------------ | ---------------------- | ----------------------------- |
| Unit and component (server + client + shared) | `pnpm test`   | **616 passed**, 20 skipped, 0 failed |
| End-to-end, full stack, real browser | `pnpm run e2e`         | **12 passed**, 0 failed (1.3 min) |
| Typecheck / lint / format / build    | `pnpm typecheck`, `pnpm lint`, `pnpm build` | clean |

The E2E run covers every critical path CLAUDE.md names: recording → chunk streaming →
persistence → transcript → summary; the auth flows; the deletion cascade; crash recovery with
reconnect from `persistedSeq`. **Nothing was left red inside the timebox.** The Keycloak service,
the realm JSON and the Keycloak database are gone from that run — the stack is Postgres, MinIO,
the API and (optionally) Whisper.

### The architectural decisions, and why

**Bearer session tokens, not cookies.** better-auth's `bearer` plugin makes it accept its session
token in `Authorization: Bearer …`. That was chosen because it maps onto the existing contract
without changing it: `server/src/auth/plugin.ts` reads a token from the header on REST calls and
from the `quorum.bearer.v1` subprotocol on the WebSocket upgrade, and both channels keep working
byte-for-byte. A cookie would have ridden along on the upgrade for free, but would have made every
mutating REST route a CSRF surface and broken the cross-origin development setup.

**The verifier keeps its signature.** `createSessionVerifier(auth)` has the type
`(token: string) => Promise<RequestContext>` — the same `TokenVerifier` the Keycloak verifier had.
Consequence: `auth/plugin.ts`, the default-deny hook, the `requireContext()` discipline, the
404-not-403 scoping, `JwtRecordingContextProvider`, the rate limiter and every route handler are
**unchanged**. The whole server-side swap is which verifier `index.ts` constructs.

**Tenant as a column on the user, not the organization plugin.** ADR-001 wants one scalar
`tenantId` per request, and a Quorum user belongs to exactly one tenant today. The organization
plugin models membership as rows plus an *active organization* on the session — a second,
switchable piece of state the entire data layer would have to respect. That is real value once a
user can belong to several tenants and worth revisiting then; before that it is overhead on the
most safety-critical value in the system. An `additionalFields` column keeps the request context a
plain projection of the user row.

**Migrations.** better-auth derives its migration plan by diffing its configured schema against
the live database (`getMigrations().runMigrations()`, called from `index.ts`). It becomes the
fourth migration owner on the one database, after the meeting store (API), `summary_templates`
(worker) and pg-boss. It is the only one whose schema change is *not* visible in a pull request
diff — see §5.

### Deliberately not done

Password reset, email verification, self-registration, social login, account admin. Sign-up
exists as an endpoint but assigning a tenant does not go through it (`input: false`), so accounts
are created by a provisioning path — in this branch, `e2e/scripts/seed-users.mjs`.

---

## 2. Migration cost

Files touched, by area. This is the actual diff of the spike, so it is a measurement rather than
an estimate — with the caveat that the spike skipped the lifecycle work both worlds still need.

| Area | Files | Effort | Notes |
| --- | --- | --- | --- |
| Server auth core | 4 new (`auth/better-auth/*`), 1 gutted (`token-verifier.ts`), `app.ts`, `config.ts`, `index.ts` | **M** | The new code is small; the reason it is small is that the contract was already an interface. |
| Server auth consumers | **0** | — | plugin, subprotocol, recording provider, rate limiter, routes: untouched. |
| Shared wire contract | `shared/src/websocket-auth.ts` | **S**, but load-bearing | See §3 — a real incompatibility, found only by running it. |
| Server tests | 9 files adapted, 1 replaced, 1 deleted (`keys.ts`) | **M** | Mechanical: `createTestAuth()`/`issueSessionToken()` mirror `createTestKeyPair()`/`signAccessToken()`. |
| Client auth | provider rewritten, `user-manager.ts` and the callback route deleted, login page rewritten, `env.ts`, i18n | **M** | Screens outside `features/auth/` compile unchanged; the context shape was kept. |
| Client tests | 1 file | **S** | Only the two return-target cases, which changed meaning. |
| E2E | fixtures, `support/env.ts`, `support/keycloak.ts` → `support/auth.ts`, `auth.spec.ts`, new `seed-users.mjs`, `run.mjs` | **M** | Sign-in got *simpler*: no provider DOM, no redirect. |
| Compose / infra | `docker-compose.yml`, `docker-compose.dev.yml`, e2e override, `e2e.env`, `.env.example`, deleted `infra/keycloak/` and the Postgres init script | **M** | Net removal. |
| Docs | 5 READMEs and runbooks | **S–M** | Wide but shallow; measured in §6. |

Rough total for a production migration, on top of the above: **1–2 weeks**, dominated not by the
swap but by (a) the account lifecycle (§7), (b) a data migration for any existing Keycloak users —
password hashes cannot be carried over between the two, so real users would have to reset — and
(c) a security review of code we would then own.

---

## 3. Two things that only showed up by running it

**The WebSocket subprotocol could not carry the token.** RFC 6455 subprotocol names are HTTP
tokens. A Keycloak access token is a JWT — base64url with dots, already inside that alphabet. A
better-auth session token is `<id>.<base64 signature>` and contains `=`, which browsers and `ws`
both reject outright ("an invalid subprotocol was specified") before the request ever reaches the
server. The fix is a base64url encoding in `shared/src/websocket-auth.ts`, so the shared contract
changed. The alternative — sending only the unsigned half, which better-auth accepts — was
rejected: it throws away the signature check on the one channel where the credential travels in a
clear-text handshake.

**better-auth refuses state-changing requests with no `Origin` header** (`MISSING_OR_NULL_ORIGIN`).
That is a reasonable CSRF defence, and it means every non-browser caller must present a trusted
origin. Keycloak's token endpoint had no such requirement. It cost one header in the E2E helper;
it would cost documentation for any future CLI or integration.

Both are small. Both are the kind of thing an evaluation that stops at "it compiles" does not find.

---

## 4. What Keycloak provides that better-auth does not

Concretely, not genericly:

1. **Account lockout.** Keycloak's brute-force detection locks the *account* after N failures,
   across sources. better-auth's limiter bounds requests per *caller*. A distributed attempt at
   one account is bounded by nothing here except the password policy. This is the single largest
   gap and it is not configuration — it is code we would write.
2. **A password policy engine.** Keycloak has configurable length, complexity, history, expiry and
   a "not a known-breached password" check. better-auth has `minPasswordLength` (set to 12) plus a
   `haveibeenpwned` plugin; history, expiry and complexity would be ours.
3. **Standards surface.** OIDC discovery, JWKS, token introspection, refresh tokens, the whole
   Authorization Code + PKCE flow. Nothing consumes it today, but it is what lets a *third* party
   integrate later without us building an API for it. better-auth can issue JWTs with a JWKS
   (`plugins/jwt`), so this is recoverable, not lost — but only for the token shape, not the flow.
4. **Signing-key rotation.** Keycloak rotates realm keys without signing anybody out. Here,
   `AUTH_SECRET` is one value; rotating it ends every session at once.
5. **An admin console and an audit surface.** Someone can look at a user, see their sessions,
   disable them, reset them. Here there is no interface at all — only SQL and the code we write.
6. **A hosted login page with its own i18n, accessibility and error handling**, maintained by
   somebody else. On the other hand it never looked like our product; see §6.
7. **Configuration as a reviewable artifact.** `realm-quorum.json` in git meant an auth change was
   a diff in a pull request. better-auth's schema is derived at runtime, so a schema change is
   invisible until it runs. This one is genuinely mitigable — `compileAuthMigrations()` prints the
   SQL, and a check that commits it would restore the property.
8. **Multi-tenancy as a modelled concept** (realms/groups), where we now own a column and the
   invariant that goes with it. Note that better-auth cannot express "server-assigned and
   mandatory" for a custom field — `required: true` applies to the input as well — so the
   `missing_tenant` invariant lives in our verifier, not in the schema. A provisioning path that
   forgets `tenantId` produces a user who can sign in but cannot use the API.

Things better-auth provides that Keycloak does not, for balance:

- **Instant revocation.** A session is a row; deleting it stops the credential on the next
  request. A Keycloak access token stayed valid until it expired, however thoroughly the session
  behind it was ended. The E2E sign-out test now asserts this.
- **No issuer mismatch class of bug.** The internal/public issuer pair — a genuine source of
  deployment confusion — simply does not exist.
- **One fewer service to be down.** Authentication is up exactly when the API is up.

---

## 5. Security surface we would now own

Honestly stated: with Keycloak, our security-relevant auth code was *one signature check*. Here it
is everything below.

| We now own | Currently | Risk if wrong |
| --- | --- | --- |
| Password storage | better-auth's scrypt defaults, unreviewed by us | Critical |
| Session issuance, signing, expiry, sliding renewal | better-auth, configured by us | Critical |
| `AUTH_SECRET` handling and rotation | one env value, no rotation path | Critical |
| Brute-force protection | per-caller rate limit only | High |
| The login form itself | our React code | High (XSS in the app now reaches a password field) |
| Tenant assignment | our provisioning code plus a verifier check | Critical — ADR-001 |
| Auth database migrations | derived at runtime | Medium |
| Dependency currency | better-auth + `better-call` + Kysely + `pg` | Medium — a CVE is now our upgrade, on our schedule |

Two more, specific to this prototype:

- **The session token is readable by JavaScript**, because the WebSocket upgrade needs it. That is
  what the OIDC access token already was, so it is not a regression — but a cookie-only design
  would have been strictly better here, and we are choosing not to have it.
- **Authentication now depends on Postgres.** Every request does an indexed session lookup. If the
  database is degraded, authentication is degraded — where a JWKS check kept working. Given that
  Postgres is already a single point of failure for domain data *and* the queue (ADR-006), this
  concentrates rather than adds risk, but it does concentrate it.

A note on the dependency: better-auth 1.7.2 declares a peer dependency on **zod 4**, and this
repository is on zod 3.25.76 for the shared schemas. It works today (better-auth resolves its own
copy), but it is an unmet peer warning on every install and a real upgrade coupling later.

---

## 6. Operational delta

**Disappears:**

- The `keycloak` service — a JVM container, its memory footprint and its ~30 s startup, on every
  developer laptop and CI run. The E2E stack starts noticeably faster.
- `infra/keycloak/` (realm JSON + README) and the Postgres init script that provisioned Keycloak's
  own database and role.
- `KEYCLOAK_*` and `OIDC_*` environment: ten variables in `.env.example`, five in the e2e env, two
  generated passwords in the E2E credential file, three `VITE_OIDC_*` build-time variables in the
  client, and the realm/issuer wait in the E2E orchestrator.
- The internal/public issuer split and the redirect-URI registration that tied the E2E client port
  to a realm file.
- A backup target: Keycloak's separate logical database.

**Appears:**

- `AUTH_SECRET` — a real secret, needed at API startup, with no rotation story.
- `AUTH_TRUSTED_ORIGINS` — needed whenever the PWA is not same-origin with the API.
- A **provisioning script**, because accounts no longer exist as imported data. This is the honest
  replacement for the realm's `users` block and it is not optional in any environment.
- Auth tables inside the domain database (not isolated, unlike Keycloak's own database) and a
  second Postgres driver in the API process (`pg` for better-auth's Kysely adapter, alongside
  `postgres.js` for the repositories).
- Our own login screen to maintain, translate and keep accessible.

Net: **four services in the stack become three**, and the "clone and `docker compose up`" promise
survives — provided the seeding step is part of it, which today it is only in the E2E path.

---

## 7. Password reset and email verification — the comparison

Both worlds are equally unfinished here. The production-auth issue describes Keycloak's state:
`resetPasswordAllowed` is true with no SMTP configured, so the reset link dead-ends.

**Keycloak needs:** SMTP settings in the production realm derivation (host, port, TLS, from,
credentials through the secrets preflight); `verifyEmail` flipped on; a decision on the onboarding
path; and `resetPasswordAllowed=false` until SMTP exists so the login form shows no dead door. The
templates, the flows, the token handling and the localised emails already exist. **Effort: S–M,
mostly configuration and a mailpit container for verification.**

**better-auth needs:** the same SMTP plumbing, *plus* the code around it. `sendResetPassword` and
`sendVerificationEmail` are callbacks we implement — so we add a mail client dependency, write and
localise the email bodies (both languages, per the i18n policy), add the reset and verification
*screens* to the PWA, and route their tokens. `requireEmailVerification` and the reset flow are a
flag each once the callbacks exist. **Effort: M, and it is application code with its own tests,
not configuration.**

That is the clearest single trade in this whole evaluation: Keycloak's remaining work is filling
in settings; better-auth's is building the flows. The counterweight is that better-auth's version
of those flows will look like Quorum, and Keycloak's will not.

---

## 8. Social login (assessed, not built)

**better-auth:** `socialProviders: { google: {...}, microsoft: {...} }` plus client IDs and
secrets, and a callback URL per provider. Genuinely a handful of lines. The unsolved part is the
same in both worlds and is *ours*: which tenant does a user who arrives via Google land in? The
tenant is server-assigned, so a social sign-up creates a user with no tenant, who can sign in and
then be refused by the API. Whatever we build, an account-linking and tenant-assignment path has
to exist first.

**Keycloak:** identity providers are realm configuration, so it is a realm JSON change plus the
same tenant-mapping question, and it additionally gives first-broker-login flows and account
linking as configurable behaviour we would otherwise write.

Neither is a reason to choose either. Both are blocked on the same product decision.

---

## 9. Recommendation

**Do not migrate now. Revisit deliberately at the point where the login experience becomes a
product concern.**

The reasoning:

1. **The prototype removes the doubt about feasibility.** It is fully green on every existing
   suite including the full E2E stack, the auth contract survived untouched, and the whole
   server-side change is which verifier is constructed. If we want this later, it is a known
   quantity — that is the main thing this spike bought.
2. **But nothing that hurts today is fixed by it.** The open production-auth work — SMTP,
   password reset, the onboarding decision — is *more* work in the better-auth world, not less,
   because it becomes application code. Migrating first and then doing that work means paying for
   the migration before collecting anything for it.
3. **It trades a small, well-understood surface for a large one we own.** With Keycloak the
   security-critical auth code in this repository is a signature check. After the migration it is
   password storage, session lifetime, brute-force protection and a password form. For a product
   whose core promise is privacy, that is a deliberate decision to make with eyes open — not a
   side effect of a stack cleanup.
4. **The operational win is real but modest**, and mostly felt on developer laptops: one JVM
   container, roughly fifteen environment variables and one backup target. Meanwhile a new
   obligation appears that has no equivalent today — every environment needs a provisioning step,
   because accounts stop existing as data.

**What would change the recommendation**, concretely:

- The landing/login page becoming a product surface we want to design — the in-app form in this
  branch is a fair preview of how much better that can look.
- Keycloak's operational weight becoming a real problem (CI time, laptop memory, a painful
  upgrade).
- Needing tenant-switching or invitations, where better-auth's organization plugin does more for
  us than a realm would.

**What would rule it out:** a compliance requirement for standards-based SSO with a customer's own
IdP. That is Keycloak's home ground, and re-adding it after removing it costs more than never
having removed it.

**Suggested next step regardless of the decision:** close the account-lifecycle gap in the world we
are actually in, which is Keycloak — SMTP, the reset door, and the onboarding decision. That work
is needed for 1.0 either way, and none of it is wasted if we migrate later.
