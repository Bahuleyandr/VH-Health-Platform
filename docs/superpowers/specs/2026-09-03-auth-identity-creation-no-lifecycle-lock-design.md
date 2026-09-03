# Identity creation takes no lifecycle lock

**Date:** 2026-09-03
**Scope:** every identity creation site in `apps/backend` (users and admins), the
`withAuthIdentityLifecycleLocks` contract, and the tests that pin it
**Status:** decided; implemented on `fix/auth-identity-creation-no-lifecycle-lock` (stacked on main
after PR #968 merged as `1c55ee04c`)
**Origin:** review finding on PR #968, deliberately left undecided there because it reverses the
author's explicit design.

## Problem

PR #968 wrapped every identity creation in `withAuthIdentityLifecycleLocks`, a blocking
`pg_advisory_xact_lock` on `vh:auth:identity:<uid>`, but took the lock **after** the INSERT or
`create`, on the uid the database had just returned. The review observed that a lock taken after
the row is written protects nothing in the window between INSERT and lock, and that the tests
named for this property (`authIdentityCreationWriterLocks.test.js`,
`auth-revocation-lock-order.deep.test.js`) did not exercise the production creation sequence at
all: the unit test's `expectOneLockAfterEachWrite` scanned forward from the write, so it could only
ever find a lock "after", and the deep test inserted its fixture autocommitted before locking.

The proposed fix was to reorder: generate the uid in the application, lock first, then write.

## What is actually true

- Creation and the lock run inside **one** transaction. MVCC hides the new row from every other
  session until commit regardless of statement order inside that transaction.
- Every identity uid is database-generated. Checked on main `1c55ee04c`: every raw
  `INSERT INTO users` / `INSERT INTO admins` omits `uid` from its column list (database default
  `gen_random_uuid()`) except `admissionService.js`, which writes `gen_random_uuid()` inline; there
  are no `upsert` or `createMany` calls on either table; the ORM creates pass no uid; and
  `userService` filters request fields through `PROFILE_FIELDS_IN_SCHEMA`, which has no `uid`.
- No creation path exposes the uncommitted uid to another transaction: no in-transaction NOTIFY,
  synchronous cache or websocket push, or response flush between INSERT and commit (every
  publish-style call near these writers is post-commit).
- The one concrete race the review named, a SCIM re-sync revoking a uid it already knows, cannot
  be constructed: SCIM reaches a known uid only through `findExistingStaff` or an existing `admins`
  row, i.e. the mutation paths, which already lock correctly; a concurrent deactivate for an
  external id that is still mid-creation resolves to `SCIM_USER_NOT_FOUND`, not to the uid.

So the creation-time lock protected nothing in either order. Lock-before-write would only become
meaningful with an application-known uid, which is exactly what reordering would have to introduce:
it manufactures the precondition for the race it then guards against.

## Options considered

1. **Reorder (B1):** pre-generate the uid with `crypto.randomUUID()`, lock, then write, at about 18
   sites; invert the contract test; add a deep test racing the real helper against a revoke-all.
   Rejected: moves a database invariant into the application piecemeal (a missed site locks uid A
   while the database writes uid B, silently wrong rather than harmlessly redundant), and the
   deep test it enables can only be built by having the harness leak the uid.
2. **Remove the creation-site locks (B2):** subtractive; keep every site's transaction shape and
   tenant scoping unchanged; keep the lifecycle lock for mutations of existing identities.
3. **Keep the code, rename the tests (B3):** leaves an inert lock in about 18 paths, the "wired
   but can never fire" pattern this repository's audits keep flagging.

## Decision: option 2

Decided through the structured-disagreement trio (advocate for B1, challenger for B2,
supervisor), then re-checked against the derived-uid objection above before implementation.

## What changed

- Creation sites no longer call `withAuthIdentityLifecycleLocks`: `authService.js`
  (`createIdentityWithLifecycleLock` renamed `createIdentityTx`, four call sites for users and
  admins), `firebaseAuthService.js` (2), `devAuthRoutes.js`, `staffService.js`, `userService.js`,
  `scimProvisioningService.js` (users and admins inserts), `appointmentCrudController.js`,
  `appointmentDocumentController.js`, `appointmentWorkflowController.js` (2),
  `bookingController.js`, `patientSearchController.js`, `abdmShareIntakeService.js`,
  `admissionService.js`, `maternityService.js`, `migrationToolkitService.js`,
  `counterSaleService.js`, `dependentsService.js`. Unused imports removed. Every site keeps its
  `setTenantTx` or `prisma.$transaction` wrapper exactly as before, so tenant scoping under the
  RESTRICTIVE `explicit_tenant_context_753` policy is unchanged.
- `withAuthIdentityLifecycleLocks` (`utils/tokenBlacklist.js`) now documents the rule: the lock
  serialises mutations of identities that already have committed, discoverable rows; creation
  does not take it; and the revisit trigger.
- Tests:
  - `authIdentityCreationWriterLocks.test.js` is a negative contract that cannot pass vacuously:
    for every writer it pins the exact insert or create count, that the write runs on a
    transaction client inside `prisma.$transaction` or `setTenantTx`, that no lock appears in the
    window after the creation's `RETURNING` (raw) or `.create(` (ORM), and that the only lock calls
    left in the file are the mutation-path ones with their exact argument lists. A tree-wide
    sweep over `src` (excluding tests) asserts no identity creation anywhere is followed by a
    lifecycle lock and that it saw at least 19 creation sites.
  - `authIdentityLifecycleWriterLocks.test.js` drops only its two creation-ordering pins
    (`createOrUpdateProfile`, SCIM upserts); every mutation-path pin stays.
  - `patientSearchController.test.js` and `staffServiceCreateProfile.test.js` assert the lock mock
    is not called on the creation path. `delegatedAuthorityWriterRevocation.test.js` is unchanged:
    it asserts the unlink path, a mutation.
  - `auth-revocation-lock-order.deep.test.js` keeps all its cases; the first is retitled to what it
    proves (a lifecycle writer blocks on the identity lock held by another open transaction and
    applies after it commits).

## Revisit trigger

Reintroduce a creation-time lock, necessarily with an application-known uid locked before the
write, only if a creation path starts exposing an uncommitted uid to another transaction: an
in-transaction NOTIFY, a synchronous cache or websocket push between INSERT and commit, or a
response flushed before the transaction resolves.

## Related open question, not addressed here

The WebSocket handshake (`utils/websocket/wsServer.js`, `registerDirectClientIfLive`) admits a
`users` identity only when `users.tenant_id` equals the ticket's tenant claim exactly, and on
mismatch the socket silently never registers (no close code). The ticket's claim is minted in
`routes/realtime/realtimeTicketRoutes.js` as `req.tenantId || user.tenant_id`, so the request-level
tenant takes precedence over the bearer's own. `admins` rows with a null `tenant_id` already pass.
Whether any legitimate path produces a mismatching `users`-realm ticket was not traced. Two things
worth deciding: an explicit close code for tenant mismatch instead of silent non-registration, and
a failing-case test for the mismatch, which nothing exercises today.
