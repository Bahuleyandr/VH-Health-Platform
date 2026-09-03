# The pre-auth surface must run tenant-scoped

**Date:** 2026-09-03
**Scope:** every handler mounted under `/api/v1/auth` (patient Firebase login, legacy register,
the phone-OTP paths, staff and admin login, the dev-only patient login), the identity creation
sites among them, and the tenant-RLS posture verdict in `src/lib/prisma.js`
**Status:** decided and implemented on `fix/preauth-identity-creation-tenant-scope` (off main
`a37bf33e3`)
**Origin:** found while closing the #968 review follow-ups; measured before anything was changed.
The platform is still in development, so this is a latent defect to close before the production
cutover, not a live outage.

## The defect

Migration 758 put the RESTRICTIVE policy `explicit_tenant_context_753` on `public.users`, and
migration 272 forces row security there; on a 762-tip database **167** FORCE-RLS tables carry a
RESTRICTIVE policy, `users`, `staff`, `doctors`, `departments`, `facilities` and `user_devices`
among them. Such a policy requires `app.current_tenant_id` to be set and to equal the row's
`tenant_id`, so with the setting unset an RLS-subject role sees **zero rows** and every
INSERT/UPDATE is rejected with SQLSTATE 42501, even when `tenant_id` is named in the statement.

Production connects as `vhhealth_runtime` (NOSUPERUSER, NOBYPASSRLS, not the owner), which is
subject to those policies. Every handler under `/api/v1/auth` runs before the tenant middleware,
`tenantContextMiddleware` deliberately leaves `req.tenantId` null on public routes (W1), so the
global `tenantRlsMiddleware` seeded an empty context and the prisma proxy scoped nothing. The
consequences on any deployment at migration 758 or later:

- the first login of a new patient failed on the `users` INSERT (a bare `prisma.$transaction`,
  whose client skips the tenant wrapper);
- a returning patient was invisible to the lookup, so the flow treated them as new and hit the
  unique constraint;
- the hospital-number helper could not see the row it had just created;
- staff login, which reads `users` and `staff`, would have found nobody.

Nothing caught it because CI and the local `.env` connect as a superuser, which bypasses row
security even under FORCE, and because the boot-time posture verdict evaluated only
`testRole || connectionRole`: with the runtime role configured it reported the role used inside
`setTenantTx` and never looked at the connection role the pre-auth handlers actually run as.

### Measured before the change (vh_dqa1, migration tip 762)

| Role running the exact Firebase new-user INSERT | tenant setting | Result |
|---|---|---|
| non-superuser owner of `users`, FORCE on | unset | rejected by `explicit_tenant_context_753` |
| non-superuser owner of `users`, FORCE on | set to the row's tenant | inserted |
| `rls_test_app` (granted, non-owner) | unset / set | rejected / inserted |
| `postgres` superuser (CI, local `.env`) | unset | inserted |
| non-superuser owner, `admins` table | unset | inserted (permissive policy only) |

At the application layer, with enforcement on and an active tenant context, a plain `prisma` call
is auto-wrapped and `setTenantTx` sets the tenant, but the client inside a bare
`prisma.$transaction` reads the setting as unset. Driving the real `authenticateWithFirebase` on a
pool made RLS-subject reproduced the INSERT rejection; after scoping only the INSERT it failed
again one step later, in the hospital-number helper's read. That second failure is what turned
the fix from "scope the creation" into "scope the surface".

### The grant question

`setTenantTx` also issues `SET LOCAL ROLE vhhealth_app` in production. On a database built only
from the migrations, `vhhealth_app` holds SELECT on `users` and INSERT on a curated 56 tables,
which would turn a policy 42501 into a privilege 42501. That is not the production shape: the
owner-credential PreSync migration Job runs `ensureTenantRlsRuntimeRoleGrants`, whose first grant
is `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` to the runtime role before
the append-only curation. Running that pass against vh_dqa1 gave `vhhealth_app` INSERT on `users`
and 958 other tables in under a second. Environments that never run the pass (a local QA clone)
must run `scripts/ensure-runtime-role-grants.mjs` before enabling the runtime role.

### Why a tenant context on the auth surface is safe

The handlers already resolve the tenant from the request host (`resolveTenantForRequest`, W4
trust-by-topology: client tenant headers are not trusted before authentication) and scope their
own lookups to it; seeding the same tenant as the context makes the rest of their statements
consistent with that. SUPER_ADMIN login keeps working: the `admins` `tenant_isolation` policy
admits rows with `tenant_id IS NULL` under any tenant setting. An unknown tenant subdomain is
rejected by the resolver (`TENANT_NOT_RESOLVED`) before any handler runs, as it was inside the
handlers before. With enforcement off (dev, QA, CI) the proxy wraps nothing and behaviour is
unchanged.

## What changed

- `middleware/preAuthTenantContextMiddleware.js` (new), mounted in `app.js` on `/api/v1/auth`
  right after the patient rate limiter and before the auth router: resolves the host tenant and
  runs the chain inside `runInTenantContext`, exactly as `tenantRlsMiddleware` does post-auth. It
  never writes `req.tenantId`, leaves an already-seeded context alone, and forwards a resolver
  error to the error handler.
- `services/auth/firebaseAuthService.js`: both creation sites (`authenticateWithFirebase`,
  `legacyRegisterUser`) run inside `setTenantTx(tenantId, ...)`; a bare transaction is never
  proxied, so the context alone would not have covered the INSERT.
- `services/auth/authService.js`: the creation helper takes `{ tenantId }`; for the users realm it
  runs inside `setTenantTx` and stamps `tenant_id` on the row (previously the column default
  supplied the default tenant). Its three users callers (`verifyOtp`, `legacyRegister`,
  `verifyOtpAndAuthenticate`) resolve the tenant from the request first. The admins realm keeps
  the bare transaction: `admins` carries only the permissive policy.
- `routes/auth/devAuthRoutes.js` (dev-only, never mounted in production): same shape.
- `lib/prisma.js`: `evaluateTenantRlsPosture` now also reports the connection role
  (`connectionRole`, `connectionBypassesRls`, `connectionRoleRlsSubject`) and how many FORCE-RLS
  tables carry a RESTRICTIVE policy (`restrictiveForcedTables`, probed from `pg_policies`); the
  OK log line carries them and, when the bare connection role is RLS-subject, says explicitly that
  writes outside a tenant transaction to those tables are rejected. The verdict's `ok`/`reason`
  semantics are unchanged: an RLS-subject connection role is the intended steady state, not a
  failure; what was missing was visibility of the path.

## Tests

- `src/tests/preauth-identity-creation-rls.deep.test.js`: pins the pool to one connection and
  `SET ROLE`s it to `rls_test_app` (provisioned by `ci-setup-db.mjs`), so every statement, scoped
  or bare, runs as an RLS-subject role exactly as in production. It pins the hazard (bare INSERT
  rejected), the control (same INSERT inside `setTenantTx` accepted), then drives the real HTTP
  path `POST /api/v1/auth/firebase/firebase-login` twice through the middleware: the first login
  registers, the second recognises the same patient and does not re-insert. Legacy registration
  runs under the same context. Before the fix the login cases failed with the policy violation and
  the returning-patient case could not have passed; a superuser connection could never show that.
- `src/tests/unit/preAuthTenantContextMiddleware.test.js`: the context the downstream handler
  sees (including across an await), an already-seeded context left alone, the empty public-route
  context replaced, and resolver errors forwarded without seeding.
- `src/tests/unit/preAuthIdentityCreationTenantScope.test.js`: source contract; every pre-auth
  creation site's nearest wrapper is `setTenantTx(tenantId, ...)`, the tenant is resolved from the
  request first, the row is stamped with it, and `app.js` mounts the middleware before the auth
  router. Exact site counts keep it from passing vacuously.
- `firebaseAuthService.test.js`, `firebaseAuthServiceCoverage.test.js`, `authService.test.js`,
  `authServiceCoverage.test.js`: the `setTenantTx` mock is a spy and the new-user cases assert it is
  called with the resolved tenant and that no bare transaction is used for creation.
- `tenantRlsPosture.test.js`: four cases for the connection-role fields.

## Not changed, deliberately

- `req.tenantId` stays null on public routes; W1's fail-closed resolution semantics for
  authenticated requests are untouched.
- The existence checks that precede creation on the legacy OTP paths (`findFirst` by phone alone)
  are not host-tenant scoped in their SQL; under enforcement the context now scopes them through
  the proxy, which is the documented W4 intent.
- `admins` creation keeps its bare transaction. If a RESTRICTIVE policy ever lands on `admins`,
  the `createAdmin` path needs the same treatment; the deep suite's hazard case is the tripwire to
  copy.
- No staff-login case in the deep suite yet (it needs a seeded staff row with a PIN); the
  middleware covers it by construction and a follow-up can add the case with the same harness.

## Interaction with #977

`fix/auth-identity-creation-no-lifecycle-lock` (#977) touches the same helper in `authService.js`
and the same two creation blocks in `firebaseAuthService.js`. Whichever lands second needs a
small merge in those hunks: keep the `setTenantTx` scoping from this branch and the lock removal
from #977 (the helper becomes a plain tenant-scoped create for users).
