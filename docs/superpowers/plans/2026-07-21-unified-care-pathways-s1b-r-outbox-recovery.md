# Unified Care Pathways S1b-r Live Outbox Recovery — Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-21-unified-care-pathways-s1b-r-outbox-recovery-design.md`
**Base:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
**Migration:** `588_event_outbox_recovery_hardening.sql`
**Delivery posture:** code and evidence only; no deployment, live migration or pathway activation

## Scope guard

Harden the existing live `event_outbox` to webhook pipeline as one inseparable recovery bundle. Do not
ship a bare redrive first. The bundle includes explicit tenant identity, leased claims, stale-worker
fencing, source and webhook reapers, atomic set-based subscription fan-out, delivery uniqueness,
active integration/subscription gates, fail-closed unsupported filters, governed dead-only redrive,
BIGINT-safe boundaries, metrics and recovery evidence.

Do not modify migrations 578–587, the projector generation contract, pathway definitions, handlers,
clinical owners, clocks, task/SLA rules, Stroke/STEMI/cath tables, OBGyn behavior, notification outbox,
patient/staff clinical UI, or tenant pathway settings. Do not define a webhook-filter language. Do not
claim exactly-once external HTTP delivery. Do not deploy, run migration 588 against a live database,
sync Forgejo, call a real webhook endpoint or notify an external party.

Migration 588 is reserved for this scope. Re-derive the tail immediately before creating it and stop on
any collision. This migration is not rolling-compatible with old unfenced workers, so implementation
and merge evidence must keep the future non-rolling cutover explicit.

## Task 1 — Pin RED security, recovery and fan-out tests

Files:

- modify `apps/backend/src/tests/event-outbox-drain-deep.test.js`
- modify `apps/backend/src/tests/unit/webhookDeliveryService.test.js`
- add `apps/backend/src/tests/event-outbox-recovery.deep.test.js`
- add `apps/backend/src/tests/webhook-delivery-recovery.deep.test.js`
- add/extend event-outbox admin route tests

Steps:

1. Record the base SHA and migration tail; verify migrations 578–587 have no scope diff.
2. Add a two-tenant regression proving a tenant ADMIN cannot list or mutate another tenant's sequential
   event ID. Exercise the real bare-transaction defect before GREEN.
3. Add RED tests for source lease owner/expiry/attempt epoch, crash recovery, unexpired-lease immunity,
   seventh-attempt dead-letter and stale-worker terminal CAS rejection.
4. Add RED tests for all-or-fail two-subscription fan-out, injected partial-insert failure, concurrent
   replay uniqueness and a legitimate zero-subscription completion.
5. Add RED tests for active/inactive subscription and parent-integration gates, parked work,
   reactivation and fail-closed non-empty filters.
6. Add a real-PostgreSQL webhook reaper test that exposes the current `last_error`/`error_message`
   mismatch; keep the existing SQL-text test only as a secondary assertion.
7. Add RED tests for dead-only source and webhook redrive, missing reason, body-actor rejection,
   cross-tenant generic not-found, concurrent CAS and audit-write rollback.
8. Tighten the current first-failure assertion to exact `pending`; do not retain
   `expect(['pending','failed'])`.
9. Keep BIGINT cases as decimal strings and extend the existing greater-than-`2^53` fixture through
   list, lease, audit and redrive.

Gate: the new assertions fail for the intended baseline defects, never because a fixture or schema is
missing.

## Task 2 — Add migration 588 and Prisma parity

Files:

- add `apps/backend/src/migrations/588_event_outbox_recovery_hardening.sql`
- modify `apps/backend/prisma/schema.prisma`
- add `apps/backend/src/tests/event-outbox-recovery-migration.deep.test.js`

Steps:

1. Add actionable preflights for invalid source statuses/attempts, duplicate non-null
   `(tenant_id,event_outbox_id,subscription_id)` groups and active non-empty subscription filters.
2. Add source `lease_owner`, `lease_expires_at` and `redrive_count`; add exact status, nonnegative,
   lease-pair and processing-state checks plus a partial stale index.
3. Add delivery `lease_owner`, `lease_expires_at` and `redrive_count`; add nonnegative, lease-pair and
   in-flight-state checks plus a partial stale index.
4. Add the partial unique `(tenant_id,event_outbox_id,subscription_id)` index. Preserve nullable ad-hoc
   delivery rows and the deliberate no-FK logical bridge.
5. Define scheduler-quiesced conversion of legacy unleased source `processing` and delivery
   `in_flight` rows to explicit retryable recovery work; audit affected counts.
6. Preserve migration 578's source INSERT trigger byte-for-byte and prove migration 588 neither adds a
   source UPDATE trigger nor mutates projector tables.
7. Apply migrations only to a disposable/QA database, run `npx prisma db pull`, and commit the regenerated
   schema with the migration.
8. Run schema drift and catalog assertions for every check/index/column. A duplicate/filter preflight
   failure must name actionable identities and never delete evidence.

Gate:

```powershell
node apps/backend/scripts/qa-cluster-up.mjs
npm --prefix apps/backend run check:schema-drift
```

No live database is in scope.

## Task 3 — Implement tenant-bound leased source processing

Files:

- modify `apps/backend/src/services/events/eventOutboxService.js`
- modify `apps/backend/src/tests/event-outbox-drain-deep.test.js`
- modify `apps/backend/src/tests/event-outbox-recovery.deep.test.js`

Steps:

1. Normalize event IDs as validated positive decimal BIGINT strings; never use `Number` or `parseInt`.
2. Make `claimPendingEvents` generate/accept a UUID lease owner, set a bounded expiry, increment attempts
   on claim and return tenant/owner/attempt epoch.
3. Replace blind terminal methods with internal tenant-bound operations requiring
   `(tenant_id,id,status='processing',lease_owner,attempts)`.
4. Run transactional source work through `setTenantTx`; repeat tenant equality in every SELECT, lock and
   UPDATE even though RLS is present.
5. Return an explicit lost-fence outcome when CAS changes zero rows. Do not report or count it as
   delivered/failed.
6. Implement bounded stale-source reaping with `FOR UPDATE SKIP LOCKED`, exact owner/epoch fencing,
   existing backoff and seven-attempt terminal behavior.
7. Export only the narrow scheduler/admin functions needed; do not leave a public blind
   mark-delivered/mark-failed escape hatch.

Gate: claim, failure, reaper and late-worker tests are exact and green against PostgreSQL.

## Task 4 — Make source fan-out atomic, set-based and idempotent

Files:

- modify `apps/backend/src/services/events/eventOutboxService.js`
- modify `apps/backend/src/services/integrations/webhookDeliveryService.js`
- modify `apps/backend/src/utils/scheduler.js`
- modify relevant deep/unit tests

Steps:

1. Add one internal `completeClaimedEventFanout`-style operation that starts with the exact source claim
   lock inside `setTenantTx`.
2. Use one `INSERT ... SELECT` for all subscriptions matching tenant and event type; join a currently
   active parent integration and require a currently active subscription plus empty filter.
3. Use the migration-588 unique tuple and `ON CONFLICT DO NOTHING`; count both existing and newly
   inserted rows as durable coverage.
4. CAS-mark the source delivered and clear its lease in the same transaction. A failure at any point
   must roll back every new delivery and source completion.
5. Remove schema-unavailable/partial-fanout resolution from the internal source bridge. Those are
   failures, not zero subscription matches.
6. Keep a legitimate zero-match completion explicit and tested.
7. Reject arbitrary source IDs on the ad-hoc admin enqueue surface. Only the internal leased operation
   may create a non-null source bridge.
8. Preserve stable delivery IDs and the at-least-once external contract.

Gate: concurrency and injected-failure tests prove exactly one durable row per eligible
tenant/event/subscription and no false source completion.

## Task 5 — Fence webhook dispatch and repair recovery gates

Files:

- modify `apps/backend/src/services/integrations/webhookDeliveryService.js`
- modify `apps/backend/src/services/integrations/webhookSubscriptionService.js`
- modify `apps/backend/src/tests/unit/webhookDeliveryService.test.js`
- modify `apps/backend/src/tests/webhook-delivery-recovery.deep.test.js`

Steps:

1. Claim webhook rows with a UUID owner, expiry and incremented `attempt_number` epoch.
2. Make claim eligibility require the current subscription and parent integration to be active.
3. Park inactive queued work without sending or silently dead-lettering it; prove reactivation resumes
   eligibility according to the existing due time.
4. Mark deleted-subscription orphans dead without opening a network connection and surface them in
   dead-letter evidence.
5. Replace ID-only `markStatus` with tenant/state/owner/epoch CAS. A stale result changes no subscription
   counter and is not reported as success.
6. Repair stale reaping to write `error_message`; select by lease expiry and fence the UPDATE with owner
   and epoch.
7. Make transaction-aware subscription counter updates throw inside the terminal transaction while
   retaining best-effort posture only where explicitly outside correctness boundaries.
8. Preserve SSRF pinning, signing, timeout, stable delivery ID and retry classifications.
9. Reject create/update/activation with non-empty `event_filter`, and retain an explicit empty-filter
   predicate in fan-out as defense in depth.

Gate: no fetch occurs for paused/inactive/orphaned work, and real PostgreSQL proves the reaper and stale
worker race.

## Task 6 — Replace blind admin mutations with governed dead-letter recovery

Files:

- modify `apps/backend/src/routes/admin/eventOutboxRoutes.js`
- modify `apps/backend/src/routes/admin/integrationRoutes.js`
- modify event/webhook services and route tests

Steps:

1. Make event listing require `req.tenantId`, pass it into the service, include an explicit tenant SQL
   predicate, validate status/pagination and preserve decimal-string IDs.
2. Add PHI access evidence for event listing because it returns patient UID and arbitrary payload.
3. Delete the event `/:id/delivered` and `/:id/failed` routes and their blind service exports.
4. Add `POST /api/v1/admin/events/:id/redrive` with failed-only CAS, bounded non-empty reason and
   server-derived actor UID/role/request ID.
5. Inside the same `setTenantTx`, capture prior attempts/error, reset the retry cycle, clear lease/error,
   increment `redrive_count` and insert the append-only `audit_logs` record. Audit failure rolls back.
6. Return one generic not-found/eligible response for missing and cross-tenant IDs; wrong own-tenant
   state returns a structured conflict without exposing another tenant.
7. Make webhook mark-dead reason-required and webhook redrive `dead`-only, reason-required and
   atomically audited. Remove succeeded/failed redrive eligibility.
8. Ignore/reject body actor fields; inherited ADMIN/SUPER_ADMIN, step-up, IP and rate controls remain.

Gate: authorization, tenant isolation, actor provenance, reason, CAS concurrency and audit atomicity
tests are green.

## Task 7 — Align admin UX and OpenAPI

Files:

- modify `apps/admin/src/lib/api/integrationAdmin.ts`
- modify `apps/admin/src/app/(with-auth)/dashboard/integrations/page.tsx`
- add/modify focused admin tests
- regenerate canonical OpenAPI artifacts through repository scripts

Steps:

1. Change the webhook redrive client to require `{ reason }`.
2. Show redrive only for `dead`; collect and validate a non-empty reason before the mutation.
3. Require a non-empty reason for mark-dead and display structured errors without revealing hidden
   resource state.
4. Keep source BIGINT IDs as strings in any event-outbox contract; do not introduce a numeric admin
   type.
5. Regenerate OpenAPI after removing two event operations and adding governed redrive request bodies.
6. Run core spec sync and admin generated-type/build gates. Do not hand-edit generated output that the
   repository scripts own.

Gate:

```powershell
npm --prefix apps/backend run openapi:generate
npm --prefix apps/backend run openapi:check
npm --prefix apps/backend run openapi:sync-core
npm --prefix apps/backend run openapi:check-core
npm --prefix apps/admin run type-check
npm --prefix apps/admin run lint
npm --prefix apps/admin test -- --runInBand
npm --prefix apps/admin run build
```

## Task 8 — Add scheduler, metrics, alerts and recovery runbook

Files:

- modify `apps/backend/src/utils/scheduler.js`
- modify `apps/backend/src/observability/reliabilityMetrics.js`
- modify metric/scheduler wiring tests
- modify `infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml`
- modify `infra/kubernetes/base/monitoring/dashboards/vhhealth-backend-reliability.json`
- modify `docs/RUNBOOK_ONCALL.md`

Steps:

1. Register a bounded source stale-lease reaper under its own `withJobLock` name.
2. Keep and repair the webhook reaper under a separate lock. Preserve existing source-drain and webhook
   dispatch cadence; these are operational values, not clinical policy.
3. Add source processing/stale, webhook in-flight/stale and parked gauges plus low-cardinality reap and
   redrive counters.
4. Serialize and collect the new metrics without breaking partial Prisma mocks.
5. Add alerts and dashboard panels for stale work and repeated reaping; validate every metric name
   against exporter output.
6. Document inventory, reasoned redrive, parked-work diagnosis, duplicate/filter preflight failure and
   scheduler-quiesced cutover/recovery commands.
7. State clearly that redriving the source does not replay the projector inbox.

Gate: metric serialization, monitoring validation and scheduler import/wiring tests are green.

## Task 9 — Prove projector independence and run the full gates

Files:

- modify `apps/backend/src/tests/event-outbox-drain-deep.test.js`
- extend relevant pathway projector coexistence tests only where needed
- no production projector source change

Steps:

1. Snapshot source and projector inbox evidence before source redrive; prove redrive changes only source
   webhook-delivery recovery state and audit evidence.
2. Prove no second projector inbox row appears and no handled/ignored/dead projector outcome changes.
3. Re-run existing S1a BIGINT, generation, trigger, backfill, lease and webhook-coexistence suites.
4. Run targeted backend tests first, then lint/raw-params, schema drift, OpenAPI drift, monitoring
   validation, backend CI shards, smokes, FHIR and security scans as applicable to the final diff.
5. Run `git diff --check` and inspect that the diff contains only S1b-r files plus generated contracts.
6. Record exact test counts and any intentionally skipped external-network test. Never call a real
   webhook.

Representative focused command from `apps/backend`:

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js `
  src/tests/event-outbox-drain-deep.test.js `
  src/tests/event-outbox-recovery.deep.test.js `
  src/tests/webhook-delivery-recovery.deep.test.js `
  src/tests/unit/webhookDeliveryService.test.js `
  --runInBand --forceExit
npm run lint
npm run check:schema-drift
npm run openapi:check
npm run openapi:check-core
```

## Task 10 — Publish evidence without deployment

Steps:

1. Rebase/refresh on the current GitHub main before final CI and re-derive every changed line anchor.
2. Confirm migration 588 is still unique and migrations 578–587 are unchanged.
3. Obtain an independent review focused on tenant isolation, lease races, transaction atomicity,
   outbound duplicate semantics, migration preflight and audit durability.
4. Publish the code through the repository's normal reviewed PR flow with deployment explicitly held.
5. Do not run the future maintenance cutover, live migrations, external webhook canary, pathway mode
   flips, Forgejo synchronization or production deployment in this plan.

## Future deployment gate — not executed here

Deployment requires a separately authorized maintenance window and operator runbook:

1. inventory source states, duplicate tuples, active filters, stale claims and parked rows;
2. stop source drains, webhook dispatchers and reapers on every replica;
3. take/verify the approved database recovery point;
4. apply migration 588 once;
5. start only the new code version;
6. verify constraints, gauges, tenant reads and reaper dry-run;
7. use an internal deduplicating sink for the canary; and
8. resume delivery only on clean evidence.

Old unfenced code must not restart after migration 588. Failure response is scheduler/traffic hold and
forward fix or approved snapshot restore, not an unsafe rolling downgrade.

## Exit evidence

- exact base and final SHAs;
- migration-tail and frozen-migration proof;
- migration preflight/catalog/schema-drift output;
- RED-to-GREEN tenant IDOR evidence;
- source/webhook lease, reaper and stale-worker race evidence;
- atomic fan-out failure and uniqueness/concurrency evidence;
- inactive-gate, parked-work and filter fail-closed evidence;
- dead-only reason/audit/actor/concurrent-redrive evidence;
- BIGINT and projector-independence evidence;
- OpenAPI/core/admin contract gates;
- metrics/alerts/runbook validation;
- focused and full CI results; and
- explicit confirmation that no deployment, live migration, external notification or pathway activation
  occurred.
