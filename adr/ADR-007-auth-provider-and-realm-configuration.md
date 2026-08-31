# ADR-007: Authentication Stays on Keycloak; Realm Configuration Becomes Declarative

**Status:** Accepted · **Date:** 2026-08-31

> Supplements ADR-006 §7, which chose Keycloak as the auth provider. That decision was made on
> developer experience and reproducibility grounds before any application code existed. This ADR
> revisits it against a working alternative and fixes the operational model that makes it hold.

## Context

ADR-006 §7 chose Keycloak largely because a versioned realm JSON plus `--import-realm` gives a
working login on a fresh checkout. Since then two things changed the ground under that argument.

**First, the alternative stopped being hypothetical.** An in-app TypeScript authentication library
(better-auth) was evaluated as a working spike rather than a paragraph of speculation: the auth
flows were reimplemented in the API and the client, and the spike branch runs green across the
full test suite — unit tests and the end-to-end suites, including the auth flows and the tenant
scoping the critical paths in `CLAUDE.md` require. Feasibility is therefore not in question. The
attraction is real and worth stating plainly: one language across the whole stack, no JVM in the
compose file, sign-in screens that are ours to design, and one fewer service for a self-hoster to
understand. Keeping Keycloak had to be argued for, not assumed.

**Second, the original argument had quietly stopped being true in production.** `--import-realm`
imports a realm that does not exist yet and then never touches it again. That is exactly right for
development and worth nothing for a deployment: after the first start, every realm change is a
click in an admin console that no diff records, no review sees, and no second environment
receives. The reproducibility that justified the choice existed only on developer laptops. A
decision to keep Keycloak that did not also fix this would be keeping the cost and dropping the
benefit.

## Decision

**Keycloak stays. Its production realm becomes a reviewed file applied on every deploy.**

### Why the provider stays

**The migration cost lands immediately and the return arrives later, if at all.** What exists
today under Keycloak as configuration — account lockout after repeated failures, a password policy
engine, email verification, password reset, signing key rotation — becomes application code under
in-app auth. The spike proves the login and token paths; it does not carry the account lifecycle
around them. SMTP delivery, reset and verification tokens with their own expiry and single-use
semantics, and the screens for all of it are work we would be writing instead of the recording
pipeline, and every one of those paths is security-sensitive in a way that a green test suite does
not fully cover.

**The product's privacy promise argues against owning it.** Quorum's pitch is that recordings of
people's meetings are handled carefully. Password storage, brute-force protection and session
revocation are precisely the components where a subtle mistake is both easy to make and expensive
to discover. Delegating them to a widely deployed, independently audited implementation is the
conservative choice, and conservative is what this part of the product should be.

**The standards surface is worth more than it looks.** A plain OIDC issuer means the API validates
tokens against a discovery document and JWKS rather than against our own library, and it means
enterprise SSO and directory federation later are configuration rather than a project.
Key rotation without signing every user out is a property we get for free and would otherwise have
to build deliberately.

**Counter-argument, honestly stated:** Keycloak remains heavy — a JVM service with real memory use
and a slow start, felt most on developer laptops and on small self-hosted boxes — and the login
screens are themeable rather than ours. We accept both. The spike stands as evidence that this is
a considered trade rather than inertia, and as a measured migration path if the trade changes.

### Why the realm becomes declarative

The production realm is a file in this repository, applied against Keycloak on every deploy by a
configuration tool that reconciles the live realm to it. Concretely:

- **Realm changes are pull requests.** Clients, mappers, session lifetimes, password policy — all
  reviewed as diffs, like any other change.
- **Applied idempotently, every deploy.** Re-running with an unchanged file is a no-op, so the
  apply is safe to make unconditional. Checksum-based skipping is deliberately turned off: it
  would make the tool skip precisely the runs that exist to correct drift.
- **Drift is reverted, not merged.** A setting changed by hand in the admin console survives until
  the next deploy and then goes back to what the file says. This is the property being bought.
- **Users are never deleted by the tool.** Users are runtime data, not configuration. The
  reconciliation deliberately excludes them; everything else absent from the file is removed.
- **The development realm keeps its own file.** It is a fixture, with relaxed transport security
  and committed test credentials, and it is never applied outside development.
- **The tool and Keycloak are version-pinned as a pair**, because each build of the tool targets
  one admin API, and upgraded together on a quarterly cadence.

## Condition of validity

**This decision is conditional on the operational model above, not on Keycloak in the abstract.**
Keycloak with a hand-clicked realm is a worse option than in-app auth, because it has the JVM cost
*and* the undocumented state. If the declarative apply is bypassed — realm changes made in the
console and not written back, the apply made conditional again, the version pairing left to
drift — then the premise of this ADR has lapsed and the choice should be reopened rather than
defended.

## Revisit triggers

Named now, so that reopening this is a normal event rather than an admission:

1. **The login and branding experience becomes a product differentiator.** As long as sign-in is a
   door, a themed Keycloak page is adequate. If the sign-up and sign-in flow becomes something we
   compete on — in-product onboarding, tenant-specific branding as a selling point — the
   argument inverts, because that is exactly what an in-app library gives us and Keycloak does not.
2. **Keycloak's operational load exceeds the quarterly-bump model.** If upgrades stop being a
   version bump and a green pipeline — breaking admin API changes, migrations that need
   hand-holding, incidents traced to the auth service — then the operational saving that justifies
   the JVM has evaporated.
3. **The in-app ecosystem covers the lifecycle equivalently.** If account lockout, a password
   policy engine and signing key rotation without forced sign-out become well-supported,
   well-tested capabilities of the library rather than application code we would write, the main
   cost argument above no longer holds.

The spike branch is retained as the measured migration path: it is the estimate, and it should be
re-run against the then-current suite rather than trusted as-is.

## Consequences

- The production realm file is now a security-relevant artifact and is reviewed as one. A change
  to session lifetimes, a client's redirect URIs or the password policy carries the weight of a
  code change, because it takes effect on the next deploy everywhere.
- The two realm files — development fixture and production — are maintained side by side and are
  deliberately not generated from one another, so that a development convenience cannot leak into
  production by construction. The cost is real: nothing warns us when only one is updated. A
  consistency check between them is a sensible follow-up.
- The deploy needs administrative credentials for Keycloak, on every deploy rather than once. That
  credential is now part of the deployment configuration and is refused by the startup preflight
  if it is left at a placeholder.
- Account creation remains a manual step in the admin console. Self-service sign-up, invitations
  and tenant onboarding are product decisions that are not made here.
- The auth flows in the end-to-end suite continue to run against the development realm, so they
  exercise the provider but not the production realm file. A realm-file mistake is caught by a
  deploy, not by the suite — which is an argument for keeping the differences between the two
  files small and mechanical.
