# Clinical-import reconciliation worklist: remove the fleet-wide concurrency cap

**Date:** 2026-09-03
**Scope:** `GET /api/v1/documents/import/reconciliation` (`listClinicalImportReconciliationItems`)
**Status:** decided; implemented on `fix/clinical-import-worklist-concurrency`
**Origin:** review finding on PR #966 (merged as `7e59f955d`), deliberately left undecided by the
reviewing session because it reverses the author's stated design.

## Problem

`acquireWorklistConcurrencySlot` took one of `LIST_CONCURRENCY_SLOTS = 4` advisory-lock slots keyed
on a constant string with no tenant id. Behind `acquireTenantWorklistLock` (one open worklist scan
per tenant, checked first) that made the slot pool a platform-wide cap: the fifth tenant to open the
Medical Records worklist received `429 IMPORT_RECONCILIATION_CONCURRENCY_EXHAUSTED` with nothing of
its own in flight, and one slow tenant could hold a slot for the full 10-second transaction budget.
That is cross-tenant availability coupling in a schema whose row-level security exists to prevent
exactly that.

The author described the design as "tenant-first plus fleet-wide advisory capacity control", so the
fleet cap was deliberate, not accidental.

## Options considered

1. **Tenant-scope the slot key.** Tried and reverted during review: behind the per-tenant lock a
   per-tenant slot pool always succeeds on slot 0, so the guard becomes structurally unreachable.
   This codebase polices guards that are wired but can never fire.
2. **Delete the fleet cap.** Keep the per-tenant single-flight lock, the 10 s transaction deadline,
   the 3 s per-statement timeouts, the 38-statement budget, the per-caller `clinicalImport` rate
   limiter, and Prisma's generic pool admission (`P2024`/`P2028`/`P2037` are breaker-recognised
   infra codes in `src/lib/prisma.js`).
3. **Keep the fleet cap, re-size it from a pinned derivation, document it as a database-protection
   backstop, and log when it engages.**

## Decision: option 2

Decided through the repo's structured-disagreement trio (advocate for option 3, challenger for
option 2, supervisor). The reasoning that settled it:

- **The cap cannot be sized against the resource it claims to protect.** The only shared resource
  at risk is the per-pod Prisma connection pool, which moves with the HPA (3 to 10 replicas). A
  Postgres advisory lock is per database, so a fleet-wide constant is a guess whatever manifest it
  is derived from. The candidate derivation in option 3 (a share of the CNPG pooler's 160 server
  connections) turned out to cite infrastructure the backend does not use: `poolers.yaml` records
  that nothing routes through the pooler yet and the backend dials the primary directly
  (`max_connections = 200`).
- **Behind the per-tenant lock, fleet concurrency is already bounded by the number of distinct
  tenants with a scan open**, a sane, non-adversarial quantity. A second cap on top rations a
  quantity that is already rationed.
- **When the cap fires it fails the wrong party by construction.** Its trigger is another tenant
  being slow; its response is rejecting a healthy tenant, with a log line that could name "cap
  engaged" but not who held the slot or why.
- **Precedent is unanimous.** The only other `pg_try_advisory_xact_lock` users are per-tenant or
  per-key fences (`pathwayReconciliationService.js`, `tenantFanout.js`); none of the roughly 3,600
  published operations carries a fleet-wide cap on a request path.
- **It is the more reversible move.** Re-adding a correctly calibrated guard once real evidence
  exists is cheap; a mis-derived guard left in place repeats a class of error this repo's 2026-08-23
  re-audit already caught once (alert logic disarmed by connection-budget reasoning anchored to the
  wrong system).

## What changed

- `src/services/import/clinicalImportReconciliationService.js`: `LIST_CONCURRENCY_SLOTS`,
  `acquireWorklistConcurrencySlot`, its call, and the `IMPORT_RECONCILIATION_CONCURRENCY_EXHAUSTED`
  code are gone. A comment at the tenant-lock call records the decision and the revisit trigger.
  `LIST_TOTAL_DB_QUERY_LIMIT = 38` is unchanged; it now carries up to four statements of slack that
  the slot probes used to consume. Tightening it is a separate, optional follow-up.
- `scripts/openapi/schemas/clinicalImport.mjs`: the operation description no longer promises "4
  database-coordinated global worklist slots" and now states that at most one worklist scan is open
  per tenant and that there is deliberately no fleet-wide cap. `src/docs/openapi.json` and the
  byte-identical `packages/vhhealth_core/swagger/openapi.json` are regenerated from it.
- Tests: `clinicalImportReconciliationPagination.test.js` drops the two fleet-slot cases and adds a
  case that runs six distinct tenants concurrently under real advisory-lock semantics (any key held
  by at most one open transaction), asserting all six are admitted, only tenant keys are held, and a
  same-tenant second scan is the only 429. `clinicalImportReconciliationLifecycleContract.test.js`
  pins the absence of the fleet cap and that the list implementation acquires exactly one lock, the
  tenant one, before any work. `clinicalImportAndPrescriptionAuthoritySourceContract.test.js` and
  `clinicalImportOpenApiContract.test.js` drop their slot-count pins.

## Not done, and why

- No resize to 16 or any other constant: see the sizing argument above.
- No per-pod, pool-aware admission control: no consumer of this endpoint exists yet (no admin or
  Flutter client calls it), so there is nothing to calibrate against.

## Revisit trigger

Reintroduce a concurrency guard only if a real high-fanout consumer ships (for example a
cross-tenant dashboard that opens many tenants' worklists on an interval) or a load test or incident
shows concurrent long-lived worklist transactions threatening per-pod Prisma pool headroom under HPA
scale-down. Size it then against live pod count and pool size, in the process (or at the pool), not
as a fleet-wide advisory-lock constant.
