# Unified Care Pathways — S1a Lossless Event-Consumer Substrate Design

- **Date:** 2026-07-18
- **Status:** Implemented by the accompanying S1a change; default-off pending review and rollout evidence.
- **Grounding revision:** `f826fe09647667f76c0b3e8c0345876b70de4318`.
- **Parent design:** [Unified Care Pathways — Program Design v3](./2026-07-14-unified-care-pathways-program-design.md), especially §3.3 and §7 S1a.
- **Posture:** backend-only, default-off, shadow/no-op only.

## 1. Outcome and hard boundary

S1a adds an independent, durable consumer ledger over the existing `event_outbox`. Exactly one live-intake generation per consumer combines commit-coupled fanout with a persistent bounded historical backfill: each committed event gets one row in the live generation, and each fresh higher generation gets one row for every retained event through its fixed cutoff, without relying on id/commit order or changing the webhook drain. The active generation is driven toward one terminal outcome per row; planned cutover evidence is zero pending, while any race/residual retired pending row is explicit nonterminal debt surfaced by a dedicated gauge. Generation handoff retains prior offsets/inbox evidence but routes future intake only to the new generation.

It adopts D1: the Pathway Spine consumes `event_outbox` through a per-event inbox ledger. It does **not** build the S1b executor or any clinical pathway behavior.

S1a control-plane writes are limited to `event_consumer_offsets` lifecycle/backfill progress and `pathway_projector_inbox` work/evidence. Projector handlers cannot create or change pathway instances, workflow runs/steps, tasks, SLA rows, notifications, patient-visible state, canonical timeline/audit rows, or any domain record. “Handled” means only that a registered shadow observer completed; it never means clinical closure, acknowledgement, or workflow progression.

### In scope

- Migration `578_pathway_projector_inbox.sql`, including a global non-PHI consumer-generation registration table, tenant-inclusive inbox identity, tenant FK, GUC-reading tenant default, checks, indexes, Pattern-A RLS, fail-closed catalog validation for pre-existing relation/index/function names, and a hardened `AFTER INSERT` fanout trigger in the same file.
- Default-off explicit generation registration and lock-fenced handoff with a `SHARE ROW EXCLUSIVE` boundary, fixed registration cutoff, and persistent bounded keyset backfill.
- Exactly one non-retired live-intake generation per consumer; commit-coupled fanout of later `event_outbox` inserts only to that generation.
- An immutable-per-generation registered-handler map.
- Generation 1 no-op observers for exactly six verified in-transaction anchors:
  - `clinical.handover.created`
  - `clinical.handover.acknowledged`
  - `clinical.prehospital_handover.created`
  - `clinical.prehospital_handover.accepted`
  - `clinical_document.discharge_summary.saved`
  - `clinical_document.discharge_summary.signed`
- Lease claiming, fenced terminal compare-and-set, bounded retries/backoff, stale-lease recovery, and dead-lettering.
- New-generation replay through an atomic handoff; old offsets/inbox evidence are retained and marked with `intake_retired_at`.
- BIGINT-safe string handling, default-off scheduler wiring, metrics, and real-Postgres exit evidence.

### Out of scope

- Any scalar **live** watermark, count-equality shortcut, source-status filter, or use of the historical backfill cursor as the live-delivery contract.
- Any `event_id` FK or destructive retention/purge path. Retirement is only the atomic handoff marker; source/evidence deletion remains separately owner-gated.
- Any domain emitter change. Appointment, ED, theatre, referral, lab, and other emitter gaps remain later-slice prerequisites.
- Any handler beyond the six anchors. When dispatched, every other current event type becomes terminal `ignored`.
- `automation_rules`, an active pathway mode, recovery UI/API, outbox redrive, or webhook uniqueness/atomicity work.
- S1b runtime, definitions, pathway instances, transitions, handoffs, tasks, SLAs, notifications, mode resolver, and reconciliation evidence.
- D3–D7. Pending-result discharge, result disposition/closure, referral acknowledgement, and surgical `sign_in` are S2–S5 clinical decisions.
- D2 `automation_rules` activation, which remains unresolved and gates S1b.
- D8/D9 domain-clock and OBGyn convergence work; both remain unresolved and gate only their named later integrations.

## 2. Verified baseline at the grounding revision

| Surface | Verified behavior and S1a implication |
|---|---|
| Outbox schema | `event_outbox.id` is `BIGSERIAL`; rows retain payload, webhook status, attempts, availability, error, and delivery timestamps. There is no consumer ledger or processing lease (`apps/backend/src/migrations/009_future_proof_clinical_ai.sql:318-338`). |
| Tenancy | Migration 239 added `tenant_id`, tenant FK/index, ENABLE+FORCE RLS and Pattern-A policy (`apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:74-98,237-276`). Migration 310 installed the GUC-reading default (`apps/backend/src/migrations/310_tenant_id_guc_default.sql:20-28,80-108`). |
| Prisma | `event_outbox.id` is Prisma `BigInt`; `tenant_id` carries the generated GUC default (`apps/backend/prisma/schema.prisma:5035-5054`). |
| Publish contract | `publishEvent({ tx })` writes atomically and rethrows; without `tx` it is best-effort and returns `null` on failure (`apps/backend/src/services/events/eventOutboxService.js:34-120`). |
| Webhook ownership | `claimPendingEvents` mutates `pending→processing` with `FOR UPDATE SKIP LOCKED`; `markDelivered`/`markFailed` own status, attempts and backoff (`apps/backend/src/services/events/eventOutboxService.js:141-259`). |
| Webhook drain | `drainEventOutbox` claims, enqueues outside a transaction, then marks delivered; no matching subscription is still delivered (`apps/backend/src/utils/scheduler.js:410-455`). |
| Logical bridge | `webhook_deliveries.event_outbox_id` is nullable BIGINT with deliberately no FK (`apps/backend/src/migrations/347_widen_event_outbox_id_to_bigint.sql:12-18`). |
| Worker scheduling | Jobs use an in-process guard plus fleet-wide advisory lock (`apps/backend/src/utils/scheduler.js:42-178`); cron registration is suppressed in tests (`apps/backend/src/utils/scheduler.js:457-462`). Shutdown can strand an already-claimed promise, so an inbox lease/reaper is mandatory. |
| BIGINT boundary | The global JSON hook returns safe ids as numbers and larger ids as strings (`apps/backend/src/bin/www.js:9-19`). The outbox deep test binds strings with `::bigint` and proves `9007199254740993` exactly (`apps/backend/src/tests/event-outbox-drain-deep.test.js:43-59,145-159,268-295`). |
| Metrics seam | `reliabilityMetrics.js` owns DB-derived outbox/webhook gauges and documents the partial-Prisma-mock import hazard (`apps/backend/src/observability/reliabilityMetrics.js:1-24,70-90,98-125`). |

The six generation-1 handlers are grounded at:

- `apps/backend/src/services/clinical/handoverService.js:287-300,379-387`
- `apps/backend/src/services/ed/ambulancePrehospitalService.js:467-480,646-658`
- `apps/backend/src/services/emr/dischargeSummaryGenerator.js:1192-1205,1319-1335`

The parent design's statement that referral and lab already emit is stale at this revision: no direct referral-lifecycle or signed clinical lab-result `publishEvent` call exists. S1a does not repair that gap and must not imply full pathway-event coverage.

## 3. Binding correctness invariants

### 3.1 Registration boundary and lossless ingestion

`event_outbox.id` is allocated before commit. A lower id can commit after a higher id, so a scalar live high-water reader can skip the lower event forever. Count equality below a candidate floor is also unsafe while an allocated lower-id row remains uncommitted.

S1a instead provides completeness through transaction-coupled ingestion:

1. Migration 578 creates no generation. The first flag-enabled tick explicitly registers the configured `(consumer_key, generation)` as that consumer's sole live-intake row (`intake_retired_at IS NULL`).
2. Registration starts by taking `SHARE ROW EXCLUSIVE` on `event_outbox`. This conflicts with INSERTs' row-exclusive table locks, so every insert already in flight finishes before registration captures `MAX(id)` as `historical_cutoff_event_id`.
3. The registration row commits before blocked future inserts resume. Every later insert therefore sees the sole live-intake generation through the migration-installed `AFTER INSERT` trigger.
4. The trigger inserts the source tenant/event key into only the non-retired generation's inbox in the same transaction as `event_outbox`; rolling back the source insert rolls back its inbox fanout.
5. Historical work is bounded by the immutable registration cutoff. A persistent `backfill_cursor_event_id` keyset-scans `cursor < id <= cutoff` in bounded pages. Cursor advancement and inbox inserts commit together, and progress advances by the last source row scanned even if every insert conflicts.
6. Replay uses a lock-fenced handoff to a fresh higher generation. Under the same `SHARE ROW EXCLUSIVE` lock, registration fails without state change unless the existing live generation has completed historical backfill. One transaction stamps its `intake_retired_at` and inserts the new generation at the fixed committed cutoff. Events through that cutoff are replayed by the new backfill; inserts unblocked after commit fan out only to the new generation. Draining old pending rows before a planned cutover is an operational evidence gate, not a database precondition; any racing/residual debt remains finite and visible.

The cursor is therefore safe only as progress through a fixed, fully committed pre-registration set. It is not a live-delivery watermark. The trigger captures every post-registration insert, including an explicitly supplied id below the persisted historical cursor. A retired generation cannot be reactivated; another replay must use a fresh higher generation. Neither live fanout nor historical backfill filters on outbox `status`, `attempts`, `available_at`, or `delivered_at`. Delivery is lossless but deliberately **unordered**; neither ingestion nor terminal processing promises commit, id, or clinical chronology order.

### 3.2 Exactly one ledger row; terminal while active

The key `(tenant_id, consumer_key, generation, event_id)` and tenant-inclusive `ON CONFLICT DO NOTHING` make trigger/backfill overlap and repeated/concurrent backfill idempotent without allowing a wrongly tenant-tagged row to suppress the correct tenant's work. While a generation is active, workers drive its rows toward terminal `handled`, `ignored`, or `dead`, whose terminal CAS is immutable. Retirement may preserve a finite pending residual as visible nonterminal debt; it does not mislabel that debt as terminal.

This is an exactly-once terminal-ledger contract, not a claim that arbitrary external effects are exactly once. Future projection writes obtain that property by sharing the tenant transaction with the terminal CAS.

### 3.3 Webhook coexistence

The trigger reads the inserted `event_outbox` row only to copy `tenant_id` and `id`; the backfiller selects historical rows. Neither path updates/deletes the source or calls `claimPendingEvents`, `markDelivered`, `markFailed`, `drainEventOutbox`, or `enqueueDelivery`.

Running S1a must leave these source fields unchanged:

- `status`
- `attempts`
- `available_at`
- `last_error`
- `delivered_at`

The new trigger writes only `pathway_projector_inbox`. It adds no source-column mutation, webhook uniqueness rule, event FK, or write to `webhook_deliveries`.

### 3.4 Registered shadow semantics

Generation-1 registry membership is exactly the six anchors in §1. Each handler is a pure no-op observer. When dispatched, a matching row becomes `handled`; every other event type becomes `ignored` with no error.

Registry construction rejects duplicate or malformed registrations instead of silently overwriting them. A process binds exactly one constructor-built registry object to each generation, and generation 1 additionally requires the canonical exported registry. Membership and semantics are immutable for a generation. Adding/removing a type or changing its meaning requires a generation bump so old evidence remains interpretable.

### 3.5 Tenant isolation and fail-closed source join

Fleet-wide registration, bounded backfill, and claiming run inside the scheduler's super-admin job context. Both trigger fanout and historical backfill copy the source `tenant_id` explicitly.

Each claimed row is processed with `setTenantTx(tenantId, ...)`. Inside that transaction the worker joins inbox to `event_outbox` on **both** `event_id` and `tenant_id`, verifies the tenant-inclusive inbox key plus matching owner token **and claim-attempt epoch**, invokes the registered observer, and CAS-writes the terminal outcome. Conflict, claim, reaper and terminal mutations all carry `tenant_id` in their identity.

There is intentionally no event FK. If the source row is missing or its tenant differs, processing fails closed, records a bounded retry/dead-letter error, and never marks the inbox row `ignored` or `handled`.

### 3.6 Claims, attempts, retry, and stale workers

Claiming uses a CTE with `FOR UPDATE SKIP LOCKED`, then atomically sets:

- `lease_owner` to a UUID;
- `lease_expires_at`;
- `attempts = attempts + 1`.

Eligibility is `status='pending'`, `next_attempt_at <= NOW()`, and `lease_owner IS NULL`. Attempts increment **only on claim**. Handler failure and the stale-lease reaper schedule retry or dead-letter without incrementing again.

Materialization and processing use pages of 100, capped at 200, and ten pages per tick by default. The scheduled S1a runner has one dispatch slot: it claims exactly one row only when that slot is ready, processes it immediately, and repeats until no due row remains or `maxBatches × claimLimit` claims have started. Queued rows remain unleased with attempts unchanged. These bounds are operational safety caps, not a throughput commitment; activation evidence determines later concurrency tuning.

Retry defaults mirror the existing outbox retry posture:

- lease 5 minutes;
- maximum claims 7;
- retry backoff below the cap: 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour, then 4 hours;
- the seventh failed claim is terminal `dead`, so no eighth-hour retry is scheduled.

An expired claim below the cap has its owner token and expiry cleared and retry scheduled. At the cap it becomes `dead`. The reaper is the authority that revokes an expired owner token; the next claim installs its token and increments the attempt epoch. A worker may finish after the timestamp passes if its claim has not been reaped, but it cannot commit after reaping/reclaim because terminal and failure CAS require both its still-current owner token and attempt epoch. The epoch fence remains effective even if a later claim deliberately reuses the same UUID. Wall-clock expiry is not part of the processing or terminal predicate.

### 3.7 Replay and retention

Production begins by explicitly registering generation 1 as the sole live-intake generation. Replay uses a fresh higher generation and is permitted only after the active generation's historical backfill is complete. Registration holds `SHARE ROW EXCLUSIVE`, validates that hard precondition, retires the old offset, and inserts the new fixed-cutoff offset in one transaction. An incomplete-backfill failure rolls back without changing either generation.

Pre-cutover events are covered by the new generation's bounded backfill; post-cutover inserts fan out only to the new live row. Prior offsets and inbox rows remain retained/queryable as evidence with `intake_retired_at` set. Retirement freezes future intake, not every old inbox transition: an already-running old tick may continue claiming/terminalizing the generation's finite existing pending work, and terminal rows remain CAS-immutable. A finite pending residual can survive cutover but receives no future trigger rows and is exposed by a dedicated retired-generation pending gauge. A retired generation cannot be made active again; another replay uses another fresh higher generation. Generation ledgers are isolated, and S1a handlers remain no-op.

`event_consumer_offsets` is an ingestion-registration, lifecycle, and fixed-cutoff historical-progress table, not a scalar live completeness cursor or a clinical projection-activation mechanism. Consumer key and current generation remain explicit validated configuration, and S1a still has no active pathway mode. Changing that configured generation is an operator-gated handoff: completed historical backfill is mandatory; a drained old generation is the recommended planned-cutover evidence, while finite residual pending debt remains allowed and observable.

All offset rows, inbox rows, and generations are retained. Retirement does not delete evidence. There is no purge job, helper, route, or FK; a later owner-approved retention design must cover source and evidence together and prove that deletion cannot silently rematerialize already-consumed work.

### 3.8 BIGINT safety

Every raw result exposes `event_id::text`; every input is a string bound as `$n::bigint`. JavaScript never applies `Number`, `parseInt`, arithmetic, or ordering to an event id. Ordering remains in SQL.

## 4. Data model

Migration `578_pathway_projector_inbox.sql` creates two tables and the live-ingestion trigger.

### 4.1 `event_consumer_offsets`

This global, non-PHI table records explicit ingestion registrations. It contains
`consumer_key`, positive `generation`, fixed `historical_cutoff_event_id`, persistent
`backfill_cursor_event_id`, `backfill_completed_at`, nullable `intake_retired_at`, `registered_at`, and
`updated_at`, keyed by `(consumer_key, generation)`. Bounds/completion checks prevent a cursor beyond
its cutoff or a false completed state. Partial unique index
`uq_event_consumer_offsets_live_consumer` on `consumer_key WHERE intake_retired_at IS NULL` enforces
exactly one live-intake generation per consumer. Migration 578
also requires a retired row to have completed backfill and `intake_retired_at >= registered_at`. It
intentionally seeds no row; default-off means no generation receives fanout until the first flag-enabled
tick registers it.

### 4.2 `pathway_projector_inbox`

| Column | Contract |
|---|---|
| `tenant_id UUID NOT NULL` | GUC-reading default; explicit source copy; FK to `tenants(id)` with NO ACTION; Pattern-A RLS. |
| `consumer_key VARCHAR(120) NOT NULL` | S1a: `care_pathway_projector`. |
| `generation INTEGER NOT NULL` | Positive immutable registry generation. |
| `event_id BIGINT NOT NULL` | Logical source link; deliberately no FK. |
| `status VARCHAR(20) NOT NULL DEFAULT 'pending'` | Check: `pending|handled|ignored|dead`. |
| `attempts INTEGER NOT NULL DEFAULT 0` | Non-negative claim count. |
| `lease_owner UUID` | Paired with lease expiry. |
| `lease_expires_at TIMESTAMPTZ(6)` | Fences the claim. |
| `next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | Retry eligibility. |
| `last_error TEXT` | PHI-free bounded diagnostic. |
| `outcome_at TIMESTAMPTZ(6)` | Terminal time. |
| `created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | Ingestion time; `outcome_at`, `next_attempt_at`, and lease timestamps record later status timing. |

Required constraints/indexes:

- primary key `(tenant_id, consumer_key, generation, event_id)`;
- `generation > 0`, `attempts >= 0`;
- lease owner/expiry nullability must match;
- pending index `(consumer_key, generation, next_attempt_at, event_id) WHERE status='pending' AND lease_owner IS NULL`;
- stale index `(consumer_key, generation, lease_expires_at, event_id) WHERE status='pending' AND lease_owner IS NOT NULL`;
- metrics index `(consumer_key, generation, status, created_at) INCLUDE (lease_owner) WHERE status IN ('pending','dead')`;
- operational tenant index `(tenant_id, consumer_key, generation, status, event_id)`;
- tenant FK only;
- ENABLE + FORCE RLS and identical Pattern-A `USING` / `WITH CHECK`.

### 4.3 Trigger

Migration 578 first revokes schema-`public` `CREATE` from `PUBLIC` and any known
`vhhealth_app`/`vhhealth_runtime` roles and fails if any still retain it. Before installing the
definer, it inspects any pre-existing
`event_consumer_offsets`, `pathway_projector_inbox`, and `event_outbox` relation through
`pg_catalog`. It fails closed unless each named object is an ordinary table (`relkind = 'r'`) owned by
`CURRENT_USER`. It likewise rejects a colliding named index unless it is an owner-matching index and
rejects a zero-argument `pathway_projector_enqueue_new_event` collision unless it is an owner-matching
function returning `trigger`; `IF NOT EXISTS` / `OR REPLACE` must never bless an attacker-controlled
lookalike.

`pathway_projector_enqueue_new_event()` is a hardened `SECURITY DEFINER` trigger function installed as
the same-named `AFTER INSERT` trigger on `event_outbox`. It is relation/operation-bound, fixes
`search_path` to `pg_catalog, pg_temp`, and uses the catalog-qualified
`OPERATOR(pg_catalog.<>)` guard before touching schema-qualified application relations. Direct execute
is revoked. It selects only the sole
`event_consumer_offsets.intake_retired_at IS NULL` row per consumer, writes tenant-inclusive inbox keys
with conflict-safe idempotency, and returns the source row unchanged. It never mutates webhook-owned
source columns.

Migration 578 revokes trigger-function execution from `PUBLIC` and known application/runtime roles.
The Dalekdefender runtime-role provisioning removes `CREATE` on schema `public` from `PUBLIC`,
`vhhealth_app`, and `vhhealth_runtime`. Because boot-time Prisma role/default-function grants can drift
these privileges, `apps/backend/src/lib/prisma.js` also re-revokes schema `CREATE` from `PUBLIC` and the
configured application role, then re-revokes this function after its broad grants/default-privilege
setup. Unit coverage pins both boot invariants.

## 5. Components

### `pathwayProjectorRegistry.js`

Imports the validated consumer/current-generation constants from `pathwayProjectorConfig.js` and exports them alongside six immutable entries, a duplicate-rejecting registry constructor, and resolver. Observer return data is bounded metadata only; observers receive no capability except the transaction/event context and perform no write.

### `pathwayProjectorService.js`

Exports:

- `registerEventConsumer`
- `materializeMissingInboxRows`
- `claimDueInboxRows`
- `processClaimedInboxRow`
- `reapStaleInboxLeases`
- `runPathwayProjectorShadowTick`

`registerEventConsumer` is idempotent only for the currently live matching generation. First
registration and later generation handoff both run under `SHARE ROW EXCLUSIVE`. Handoff requires a fresh
higher generation plus completed historical backfill on the prior live generation; otherwise it throws
and the transaction leaves lifecycle state unchanged. Zero old pending rows is recommended cutover
evidence but is deliberately not a liveness-blocking database precondition. A retired generation is never
reactivated.

The runner ensures the configured generation is registered, keyset-backfills bounded historical pages until caught up or the materialization cap is reached, then repeatedly claims one row into its single available dispatch slot and processes it immediately. It stops when work is exhausted or the explicit `maxBatches × claimLimit` per-tick claim budget is consumed. It returns counts only and never logs payload, patient uid, aggregate id, or raw SQL parameters.

### Scheduler

Both jobs are inert unless the validated configuration resolves `PATHWAY_PROJECTOR_SHADOW_ENABLED=true`. Migration 578 seeds no registration, so the trigger has no registered target and fans out nothing in a never-enabled deployment. The first enabled tick durably registers the configured generation. If the flag is later turned off, scheduled backfill, processing, and reaping pause, but the current live-intake row is **not** retired and commit-coupled trigger intake continues so events are not lost; re-enabling drains the backlog. Retirement occurs only as part of a successful higher-generation handoff.

- Every two minutes: dynamically import and run register/backfill/claim-on-dispatch/process.
- Every five minutes: dynamically import and reap expired leases.

There is no `active` value in S1a. Dynamic import avoids widening the scheduler's eager module graph and partial-mock blast radius.

### Observability

Add DB-derived gauges:

- `pathway_projector_inbox_pending_rows`
- `pathway_projector_inbox_oldest_pending_age_seconds`
- `pathway_projector_inbox_leased_rows`
- `pathway_projector_inbox_dead_rows`
- `pathway_projector_inbox_retired_pending_rows`

Current pending/age/leased/dead queries are scoped to the configured consumer key and current generation, backed by the pending/dead partial covering index. The label-free `pathway_projector_inbox_retired_pending_rows` gauge joins retired offsets for the canonical consumer and counts their pending inbox rows across retired generations without mixing that debt into current-generation health. Retired generations remain retained and queryable as replay evidence. Dead rows surface through metrics, bounded PHI-free logs, and direct DB inspection. No recovery API/UI is added.

## 6. Test and acceptance matrix

### Registry unit test

`apps/backend/src/tests/unit/pathwayProjectorRegistry.test.js` proves:

- all six anchors resolve;
- a current non-member domain event does not;
- duplicate/malformed registrations throw;
- entries and semantics cannot mutate inside generation 1;
- observers are no-op and Prisma-independent.

### Lossless delivery deep test

`apps/backend/src/tests/pathway-event-delivery.deep.test.js` proves on real PostgreSQL:

1. Registering a generation waits for an earlier uncommitted insert, includes it below the fixed cutoff, and leaves no registration-to-trigger gap.
2. Inverted commit order is captured without depending on a polling materializer.
3. Rolling back an `event_outbox` insert rolls back trigger fanout; committing persists both.
4. Bounded keyset backfill persists and resumes its cursor through the fixed cutoff.
5. Cursor progress advances to the last source row scanned even when every inbox insert conflicts and the materialized count is zero.
6. A post-cursor explicit low id is still trigger-captured.
7. Repeated/concurrent backfill plus trigger overlap leaves one tenant-scoped row.
8. A wrong-tenant inbox row cannot poison or suppress the correct tenant's materialization.
9. The schema/trigger enforce exactly one non-retired live-intake generation per consumer.
10. Handoff fails atomically when the prior generation's historical backfill is incomplete.
11. A successful handoff can preserve a finite old pending residual, retires the old row, and registers a fresh higher generation at one lock-fenced cutoff; pre-cutover history reaches the new backfill and post-cutover events reach only the new generation.
12. A retired generation cannot be reactivated and receives no later trigger fanout.
13. Retirement does not abort an already-running old tick: it may claim/terminalize finite existing pending work, while terminal CAS remains immutable.
14. Concurrent claimers receive disjoint work and every claim/reaper/CAS identity includes tenant.
15. Claim atomically increments attempts once; failure/reaper schedules retry without double-increment.
16. Crash and stale lease recover; old worker is fenced; repeated failure reaches `dead` at the cap.
17. Tenant A cannot read/claim/finish tenant B under RLS.
18. The scheduled single dispatch slot leases only its current row; queued work keeps `attempts=0`, and the tick stops at the explicit claim safety cap.
19. `9007199254740993` round-trips exactly as text.
20. A six-anchor event becomes `handled`; another domain event becomes `ignored`.
21. Source-missing/tenant-mismatch processing fails closed.
22. Outcomes are lossless but no ordering assertion is made.

The inverted-order test uses two explicit DB transactions and deterministic barriers, not sleeps.

### Replay deep test

`apps/backend/src/tests/pathway-projector-replay.deep.test.js` proves:

- generation 2 handoff is rejected until generation 1 is fully backfilled;
- successful handoff gives generation 2 its own fixed cutoff/cursor while marking generation 1 retired;
- generation 1's offset/inbox evidence is retained, any finite pending residual is observable, and it receives no future trigger fanout;
- generation 2 receives retained history through backfill and all future live intake;
- idempotent current-generation rediscovery/reruns do not duplicate, and a retained old residual may be
  terminalized once without reactivating its retired generation;
- attempting to reactivate generation 1 is rejected; changed registry membership requires a fresh higher-generation fixture.

### Boot privilege hardening

Dynamic migration-negative smoke coverage must pre-squat, at minimum, a wrong-owner table, a named
index collision, and a zero-argument function owner collision. Each case must prove migration failure
and absence of the `event_outbox` projector trigger; post-migration catalog inspection alone is
insufficient. The migration itself
pins `search_path = pg_catalog, pg_temp`, uses the catalog-qualified relation/operation guard, and
revokes direct execution.

`apps/backend/src/tests/unit/prismaCoverage.test.js` proves the Prisma boot-time role grant path
re-revokes `CREATE` on schema `public` from `PUBLIC` and the application role and re-revokes direct
execution of `pathway_projector_enqueue_new_event()` after its broad function grants, so restart/role
repair cannot undo the migration's definer hardening. The Dalekdefender role SQL provides the same
no-`CREATE` posture for provisioned application/runtime roles.

### Webhook coexistence

Extend `apps/backend/src/tests/event-outbox-drain-deep.test.js` to snapshot source status/attempts/availability/error/delivery time, run S1a, prove the snapshot and delivery rows are unchanged, then run the existing drain and prove its prior delivery/BIGINT behavior.

## 7. File inventory

Production:

- Create `apps/backend/src/migrations/578_pathway_projector_inbox.sql`.
- Regenerate `apps/backend/prisma/schema.prisma`.
- Create `apps/backend/src/config/pathwayProjectorConfig.js`.
- Create `apps/backend/src/services/events/pathwayProjectorRegistry.js`.
- Create `apps/backend/src/services/events/pathwayProjectorService.js`.
- Modify `apps/backend/.env.example`.
- Modify `apps/backend/src/lib/prisma.js`.
- Modify `apps/backend/src/utils/validateEnv.js`.
- Modify `apps/backend/src/utils/scheduler.js`.
- Modify `apps/backend/src/observability/reliabilityMetrics.js`.
- Modify `infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql`.

Tests:

- Create `apps/backend/src/tests/unit/pathwayProjectorRegistry.test.js`.
- Create `apps/backend/src/tests/unit/pathwayProjectorConfig.test.js`.
- Create `apps/backend/src/tests/unit/pathwayProjectorSchedulerWiring.test.js`.
- Create `apps/backend/src/tests/pathway-event-delivery.deep.test.js`.
- Create `apps/backend/src/tests/pathway-projector-replay.deep.test.js`.
- Modify `apps/backend/src/tests/event-outbox-drain-deep.test.js`.
- Modify `apps/backend/src/tests/reliability-metrics.deep.test.js`.
- Modify `apps/backend/src/tests/unit/prismaCoverage.test.js`.
- Modify reliability-metrics unit tests for the added gauges/query result.

Conditional only if the comprehensive seeder proves it necessary:

- Add the narrowest new-table `TABLE_COLUMN_SEED_OVERRIDES` entry in `apps/backend/scripts/seed-comprehensive-test-data.mjs`. Do not add one speculatively.

No other app, route, OpenAPI, infra beyond the named Dalekdefender role-provisioning file, timeline/audit, task, workflow, notification, or domain-service file belongs in S1a.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Late lower ids are lost | Registration's table lock closes the pre/post boundary; fixed-cutoff history is keyset-backfilled and every later insert is trigger-captured, including an explicit lower id. |
| Two generations receive live fanout | Partial unique live-intake index plus trigger predicate `intake_retired_at IS NULL`; handoff retires old and inserts new under one table lock/transaction. |
| Handoff races with old pending work | Completed historical backfill is the hard precondition; zero pending is recommended cutover evidence. Any residual is finite, retained, receives no new intake, and surfaces in a dedicated gauge. |
| Retired generation is accidentally reused | Registration rejects retired/same-or-lower generations; replay always uses a fresh higher generation. |
| Backlog scans or processing overload the DB | Historical input is bounded by persistent keyset progress through a fixed cutoff; each tick has page/claim safety caps. Activation requires representative backlog-recovery, tick-duration, stale/dead, pool and statement-timeout evidence. |
| Consumers assume ordering | API and tests state lossless-but-unordered; domain chronology comes from payload/domain evidence later. |
| Crash strands work | Expiring lease, attempt-on-claim, token-revoking reaper and owner-token-fenced terminal CAS. |
| Slow handlers expire unstarted batch leases | The single dispatch slot claims only when ready; queued rows retain no lease and no attempt. |
| Reaper double-counts attempts | Failure/reaper never increment; only claim does. |
| Flag is turned off after registration | Processing/reaping pauses but does not retire the active intake row; durable trigger intake continues and re-enable drains the retained backlog. |
| Source relation drifts without FK | Join on event+tenant and fail closed; retain source/inbox; explicit deep test. |
| BIGINT rounds | Text casts and 2^53+1 proof. |
| “Handled” is mistaken for closure | Definition is shadow observer completion only; six no-op handlers; no domain writes. |
| Registry meaning changes invisibly | Immutable per generation; any membership/semantic change bumps generation. |
| Webhook behavior changes | Read-only source access and coexistence snapshot regression. |
| A pre-created object captures trusted migration/definer behavior | Before definer installation, migration 578 resolves the named table, index, and zero-argument trigger-function objects through `pg_catalog` and aborts on an unexpected owner, kind, or function shape. |
| A writable `public` schema permits dependency shadowing around privileged code | The definer fixes `search_path` to `pg_catalog, pg_temp`, schema-qualifies application objects, uses a catalog-qualified operator guard, and deployment provisioning revokes schema `CREATE` from `PUBLIC` and runtime/application roles. |
| Boot-time grants reopen trigger-function execution | Prisma role setup explicitly re-revokes the function after broad grants; `prismaCoverage.test.js` pins the invariant. |
| Boot-time role repair restores schema `CREATE` | Prisma role setup re-revokes `CREATE` from `PUBLIC` and the configured application role; Dalekdefender provisioning independently removes it from `PUBLIC`, `vhhealth_app`, and `vhhealth_runtime`. |
| Migration search-path hardening leaks into or is lost between runner statements | Security-sensitive references are catalog/schema-qualified; canonical-runner smoke records migration 578 and proves the session search path is unchanged after apply. |
| PHI leaks in telemetry | Count-only logs/metrics; no payload or patient identifiers. |
| Storage grows | Deliberate retain-by-default until joint retention is owner-signed. |

## 9. Definition of done

S1a is done only when:

- the canonical migration runner records 578 on a disposable scratch DB, leaves the connection search
  path unchanged, and the regenerated Prisma schema agrees;
- dynamic hostile-precreation smoke proves migration 578 fails closed before definer/trigger
  installation for wrong-owner table, index-name collision, and zero-argument function-owner collision
  cases;
- no generation is migration-seeded; first enabled execution atomically registers it under the `SHARE ROW EXCLUSIVE` boundary;
- trigger/source rollback atomicity, fixed-cutoff cursor persistence/restart, post-cursor low-id fanout, and tenant-poison isolation are proven;
- exactly one non-retired generation exists per consumer; trigger fanout selects only it;
- handoff fails without state change until the prior generation is fully backfilled;
- successful handoff atomically retires old/registers fresh higher, gives the new generation complete pre-cutover backfill plus sole post-cutover intake, preserves/exposes any finite retired pending debt, and forbids retired-generation reactivation;
- planned cutover evidence reports zero old pending where practical, while tests prove a racing residual does not block liveness and is counted by `pathway_projector_inbox_retired_pending_rows`;
- tenant-inclusive inbox PK/mutation keys, tenant FK, GUC default, ENABLE+FORCE RLS and Pattern-A policy are proven;
- no scalar live cursor, count shortcut, source-status filter, event FK, or destructive retention/purge path exists;
- generation 1 contains exactly the six no-op observers and every dispatched non-member domain event is ignored;
- handler membership is immutable per generation;
- the scheduled runner claims only on dispatch; queued attempts stay unchanged; attempts increment once on claim and never on failure/reaper;
- event+tenant join fails closed;
- current-generation metrics are consumer/generation-scoped, a dedicated gauge exposes retired pending debt, and retired-generation replay evidence remains queryable;
- the definer uses `search_path = pg_catalog, pg_temp`, schema-qualified application relations, and a catalog-qualified relation/operation guard;
- migration and Prisma boot paths both revoke direct trigger-function execution; Dalekdefender provisioning and Prisma boot both remove runtime/application schema-`CREATE`, with boot re-revoke unit coverage;
- all exit-evidence tests pass on PostgreSQL, including registration/trigger/backfill/handoff boundaries, concurrency, crash, stale lease, tenancy, replay, webhook coexistence and 2^53+1;
- representative backlog recovery/load evidence supports activation; tick caps are not presented as a throughput guarantee;
- comprehensive seed, schema guards, lint, targeted suites and full chunked backend gate pass;
- one PR reports the exact build ledger and the worker stops after opening it.

## 10. Deferred decisions

No unresolved question blocks S1a: D1 is adopted and resolved for this substrate. D2 remains unresolved and gates S1b; D8 and D9 remain unresolved and gate only their named later integrations. D3–D7 retain their pathway-slice gates.

Deferred by safe design:

- source/offset/inbox retention duration and purge evidence;
- real pathway handler expansion beyond the six observed anchors;
- missing domain emitters and which become required in-transaction anchors;
- all D3–D7 clinical policies;
- S1b projections, runtime, tasks/SLAs, workbench and active mode.

Until those are signed, the binding defaults are: retain active/retired offsets and inbox evidence, no event FK or destructive purge, six no-op observers only, dispatched non-member events become ignored, and default-off shadow processing. Before the first enable there is no registration or fanout; after registration, disabling pauses workers but does not retire the sole live-intake generation. Retirement occurs only during a validated fresh-higher-generation handoff.
