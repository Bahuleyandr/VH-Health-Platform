# Unified Care Pathways — S1a Lossless Event-Consumer Substrate Design

- **Date:** 2026-07-18
- **Status:** Implemented by the accompanying S1a change; default-off pending review and rollout evidence.
- **Grounding revision:** `f826fe09647667f76c0b3e8c0345876b70de4318`.
- **Parent design:** [Unified Care Pathways — Program Design v3](./2026-07-14-unified-care-pathways-program-design.md), especially §3.3 and §7 S1a.
- **Posture:** backend-only, default-off, shadow/no-op only.

## 1. Outcome and hard boundary

S1a adds an independent, durable consumer ledger over the existing `event_outbox`. It proves that every committed retained event receives exactly one terminal inbox outcome per consumer generation without relying on id/commit order and without changing the webhook drain.

It adopts D1: the Pathway Spine consumes `event_outbox` through a per-event inbox ledger. It does **not** build the S1b executor or any clinical pathway behavior.

S1a may write only `pathway_projector_inbox`. It cannot create or change pathway instances, workflow runs/steps, tasks, SLA rows, notifications, patient-visible state, canonical timeline/audit rows, or any domain record. “Handled” means only that a registered shadow observer completed; it never means clinical closure, acknowledgement, or workflow progression.

### In scope

- Migration `578_pathway_projector_inbox.sql`, including the tenant FK, GUC-reading tenant default, checks, indexes, and Pattern-A RLS in the same file.
- A bounded **floorless** anti-join over every retained `event_outbox` row.
- An immutable-per-generation registered-handler map.
- Generation 1 no-op observers for exactly six verified in-transaction anchors:
  - `clinical.handover.created`
  - `clinical.handover.acknowledged`
  - `clinical.prehospital_handover.created`
  - `clinical.prehospital_handover.accepted`
  - `clinical_document.discharge_summary.saved`
  - `clinical_document.discharge_summary.signed`
- Lease claiming, fenced terminal compare-and-set, bounded retries/backoff, stale-lease recovery, and dead-lettering.
- New-generation replay with old generations retained.
- BIGINT-safe string handling, default-off scheduler wiring, metrics, and real-Postgres exit evidence.

### Out of scope

- Any `scan_floor`, watermark, high-water cursor, count-equality shortcut, or source-status filter.
- Any `event_id` FK or purge path. Source and evidence retention are unsigned.
- Any domain emitter change. Appointment, ED, theatre, referral, lab, and other emitter gaps remain later-slice prerequisites.
- Any handler beyond the six anchors. Every other current event type is terminal `ignored`.
- `automation_rules`, an active pathway mode, recovery UI/API, outbox redrive, or webhook uniqueness/atomicity work.
- S1b runtime, definitions, pathway instances, transitions, handoffs, tasks, SLAs, notifications, mode resolver, and reconciliation evidence.
- D3–D7. Pending-result discharge, result disposition/closure, referral acknowledgement, and surgical `sign_in` are S2–S5 clinical decisions.
- D8/D9 domain-clock and OBGyn convergence work.

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

### 3.1 Floorless completeness

`event_outbox.id` is allocated before commit. A lower id can commit after a higher id. A scalar high-water reader can therefore skip the lower event forever.

Count equality below a candidate floor is also unsafe: an uncommitted lower-id row is invisible to both counts, so the counts can appear equal while the future gap already exists.

S1a has **no scan floor at all**. Its only materializer is:

```sql
INSERT INTO pathway_projector_inbox (
  tenant_id, consumer_key, generation, event_id
)
SELECT e.tenant_id, $1, $2::integer, e.id
FROM event_outbox e
WHERE NOT EXISTS (
  SELECT 1
  FROM pathway_projector_inbox i
  WHERE i.consumer_key = $1
    AND i.generation = $2::integer
    AND i.event_id = e.id
)
ORDER BY e.id
LIMIT $3
ON CONFLICT (consumer_key, generation, event_id) DO NOTHING
RETURNING event_id::text, tenant_id::text;
```

It has no predicate on outbox `status`, `attempts`, `available_at`, or `delivered_at`. Bounded batches protect the DB, but every batch starts from the same floorless anti-join. Delivery is lossless but deliberately **unordered**; neither discovery nor terminal processing promises commit, id, or clinical chronology order.

### 3.2 Exactly one terminal ledger row

The key `(consumer_key, generation, event_id)` and `ON CONFLICT DO NOTHING` make repeated/concurrent discovery idempotent. Terminal CAS makes `handled`, `ignored`, and `dead` immutable inside a generation.

This is an exactly-once terminal-ledger contract, not a claim that arbitrary external effects are exactly once. Future projection writes obtain that property by sharing the tenant transaction with the terminal CAS.

### 3.3 Webhook coexistence

The projector selects from `event_outbox` but never updates/deletes it and never calls `claimPendingEvents`, `markDelivered`, `markFailed`, `drainEventOutbox`, or `enqueueDelivery`.

Running S1a must leave these source fields unchanged:

- `status`
- `attempts`
- `available_at`
- `last_error`
- `delivered_at`

It adds no trigger, uniqueness rule, FK, or write to `webhook_deliveries`.

### 3.4 Registered shadow semantics

Generation-1 registry membership is exactly the six anchors in §1. Each handler is a pure no-op observer. A matching row becomes `handled`; all other event types become `ignored` with no error.

Registry construction rejects duplicate or malformed registrations instead of silently overwriting them. A process binds exactly one constructor-built registry object to each generation, and generation 1 additionally requires the canonical exported registry. Membership and semantics are immutable for a generation. Adding/removing a type or changing its meaning requires a generation bump so old evidence remains interpretable.

### 3.5 Tenant isolation and fail-closed source join

Fleet-wide discovery/claiming runs inside the scheduler's super-admin job context and copies the source `tenant_id` explicitly.

Each claimed row is processed with `setTenantTx(tenantId, ...)`. Inside that transaction the worker joins inbox to `event_outbox` on **both** `event_id` and `tenant_id`, verifies the matching owner token **and claim-attempt epoch**, invokes the registered observer, and CAS-writes the terminal outcome.

There is intentionally no event FK. If the source row is missing or its tenant differs, processing fails closed, records a bounded retry/dead-letter error, and never marks the inbox row `ignored` or `handled`.

### 3.6 Claims, attempts, retry, and stale workers

Claiming uses a CTE with `FOR UPDATE SKIP LOCKED`, then atomically sets:

- `lease_owner` to a UUID;
- `lease_expires_at`;
- `attempts = attempts + 1`.

Eligibility is `status='pending'`, `next_attempt_at <= NOW()`, and `lease_owner IS NULL`. Attempts increment **only on claim**. Handler failure and the stale-lease reaper schedule retry or dead-letter without incrementing again.

Defaults mirror the existing outbox retry posture:

- batch 100, capped at 200;
- lease 5 minutes;
- maximum claims 7;
- retry backoff below the cap: 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour, then 4 hours;
- the seventh failed claim is terminal `dead`, so no eighth-hour retry is scheduled.

An expired claim below the cap has its owner token and expiry cleared and retry scheduled. At the cap it becomes `dead`. The reaper is the authority that revokes an expired owner token; the next claim installs its token and increments the attempt epoch. A worker may finish after the timestamp passes if its claim has not been reaped, but it cannot commit after reaping/reclaim because terminal and failure CAS require both its still-current owner token and attempt epoch. The epoch fence remains effective even if a later claim deliberately reuses the same UUID. Wall-clock expiry is not part of the processing or terminal predicate.

### 3.7 Replay and retention

Production begins at generation 1. Replay uses generation 2 or later; the anti-join creates a fresh row for every retained source event. Prior generations are never rewound or mutated.

S1a has no generation-control table and no promotion concept because it has no projection to activate. Consumer key and generation are explicit runner inputs/constants.

All inbox rows and generations are retained. There is no purge job, helper, route, or FK. A later owner-approved retention design must cover source and evidence together and prove that deletion cannot silently rematerialize already-consumed work.

### 3.8 BIGINT safety

Every raw result exposes `event_id::text`; every input is a string bound as `$n::bigint`. JavaScript never applies `Number`, `parseInt`, arithmetic, or ordering to an event id. Ordering remains in SQL.

## 4. Data model

Migration `578_pathway_projector_inbox.sql` creates:

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
| `created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | Materialization time; `outcome_at`, `next_attempt_at`, and lease timestamps record later status timing. |

Required constraints/indexes:

- primary key `(consumer_key, generation, event_id)`;
- `generation > 0`, `attempts >= 0`;
- lease owner/expiry nullability must match;
- global-worker pending index `(consumer_key, generation, next_attempt_at, event_id) WHERE status='pending' AND lease_owner IS NULL`;
- global-worker stale index `(consumer_key, generation, lease_expires_at, event_id) WHERE status='pending' AND lease_owner IS NOT NULL`;
- operational tenant index `(tenant_id, consumer_key, generation, status, event_id)`;
- tenant FK only;
- ENABLE + FORCE RLS and identical Pattern-A `USING` / `WITH CHECK`.

## 5. Components

### `pathwayProjectorRegistry.js`

Exports the consumer/generation constants, six immutable entries, a duplicate-rejecting registry constructor, and resolver. Observer return data is bounded metadata only; observers receive no capability except the transaction/event context and perform no write.

### `pathwayProjectorService.js`

Exports:

- `materializeMissingInboxRows`
- `claimDueInboxRows`
- `processClaimedInboxRow`
- `reapStaleInboxLeases`
- `runPathwayProjectorShadowTick`

The runner materializes bounded batches until empty or a per-tick cap, claims a due batch, processes each row with fault isolation, and returns counts only. It never logs payload, patient uid, aggregate id, or raw SQL parameters.

### Scheduler

Both jobs are inert unless `PATHWAY_PROJECTOR_SHADOW_ENABLED=true`.

- Every two minutes: dynamically import and run bounded materialize/claim/process.
- Every five minutes: dynamically import and reap expired leases.

There is no `active` value in S1a. Dynamic import avoids widening the scheduler's eager module graph and partial-mock blast radius.

### Observability

Add DB-derived gauges:

- `pathway_projector_inbox_pending_rows`
- `pathway_projector_inbox_oldest_pending_age_seconds`
- `pathway_projector_inbox_leased_rows`
- `pathway_projector_inbox_dead_rows`

Dead rows surface through metrics, bounded PHI-free logs, and direct DB inspection. No recovery API/UI is added.

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

1. Inverted commit order: higher id commits/is observed first; later lower id is still found.
2. Repeated/concurrent materializers leave one row.
3. Concurrent claimers receive disjoint work.
4. Claim atomically increments attempts once.
5. Failure/reaper schedules retry without double-increment.
6. Crash and stale lease recover; old worker is fenced.
7. Repeated failure reaches `dead` at the cap.
8. Tenant A cannot read/claim/finish tenant B under RLS.
9. Missing work after a bounded batch is found by the next floorless sweep.
10. `9007199254740993` round-trips exactly as text.
11. A six-anchor event becomes `handled`; another domain event becomes `ignored`.
12. Source-missing/tenant-mismatch processing fails closed.
13. Outcomes are lossless but no ordering assertion is made.

The inverted-order test uses two explicit DB transactions and deterministic barriers, not sleeps.

### Replay deep test

`apps/backend/src/tests/pathway-projector-replay.deep.test.js` proves:

- generation 1 and 2 each get one terminal row per retained event;
- generation 2 does not mutate generation 1;
- rerunning either generation does not duplicate;
- changed registry membership is rejected for generation 1 and represented only by a new-generation registry fixture.

### Webhook coexistence

Extend `apps/backend/src/tests/event-outbox-drain-deep.test.js` to snapshot source status/attempts/availability/error/delivery time, run S1a, prove the snapshot and delivery rows are unchanged, then run the existing drain and prove its prior delivery/BIGINT behavior.

## 7. File inventory

Production:

- Create `apps/backend/src/migrations/578_pathway_projector_inbox.sql`.
- Regenerate `apps/backend/prisma/schema.prisma`.
- Create `apps/backend/src/services/events/pathwayProjectorRegistry.js`.
- Create `apps/backend/src/services/events/pathwayProjectorService.js`.
- Modify `apps/backend/src/utils/scheduler.js`.
- Modify `apps/backend/src/observability/reliabilityMetrics.js`.

Tests:

- Create `apps/backend/src/tests/unit/pathwayProjectorRegistry.test.js`.
- Create `apps/backend/src/tests/pathway-event-delivery.deep.test.js`.
- Create `apps/backend/src/tests/pathway-projector-replay.deep.test.js`.
- Modify `apps/backend/src/tests/event-outbox-drain-deep.test.js`.
- Modify reliability-metrics unit tests for the added gauges/query result.

Conditional only if the comprehensive seeder proves it necessary:

- Add the narrowest new-table `TABLE_COLUMN_SEED_OVERRIDES` entry in `apps/backend/scripts/seed-comprehensive-test-data.mjs`. Do not add one speculatively.

No other app, route, OpenAPI, infra, timeline/audit, task, workflow, notification, or domain-service file belongs in S1a.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Late lower ids are lost | No floor/cursor/count shortcut exists; floorless anti-join only. |
| Full anti-join cost grows | Bounded batches, PK anti-join, advisory lock and measured tuning; correctness is not traded for a watermark. |
| Consumers assume ordering | API and tests state lossless-but-unordered; domain chronology comes from payload/domain evidence later. |
| Crash strands work | Expiring lease, attempt-on-claim, token-revoking reaper and owner-token-fenced terminal CAS. |
| Reaper double-counts attempts | Failure/reaper never increment; only claim does. |
| Source relation drifts without FK | Join on event+tenant and fail closed; retain source/inbox; explicit deep test. |
| BIGINT rounds | Text casts and 2^53+1 proof. |
| “Handled” is mistaken for closure | Definition is shadow observer completion only; six no-op handlers; no domain writes. |
| Registry meaning changes invisibly | Immutable per generation; any membership/semantic change bumps generation. |
| Webhook behavior changes | Read-only source access and coexistence snapshot regression. |
| PHI leaks in telemetry | Count-only logs/metrics; no payload or patient identifiers. |
| Storage grows | Deliberate retain-by-default until joint retention is owner-signed. |

## 9. Definition of done

S1a is done only when:

- migration 578 and regenerated Prisma schema agree on a disposable scratch DB;
- tenant FK, GUC default, ENABLE+FORCE RLS and Pattern-A policy are proven;
- no scan floor, cursor, count shortcut, source-status filter, event FK, or purge exists;
- generation 1 contains exactly the six no-op observers and all other domain events are ignored;
- handler membership is immutable per generation;
- attempts increment once on claim and never on failure/reaper;
- event+tenant join fails closed;
- all exit-evidence tests pass on PostgreSQL, including inverted commit order, concurrency, crash, stale lease, tenancy, replay, webhook coexistence and 2^53+1;
- comprehensive seed, schema guards, lint, targeted suites and full chunked backend gate pass;
- one PR reports the exact build ledger and the worker stops after opening it.

## 10. Deferred decisions

No unresolved question blocks S1a.

Deferred by safe design:

- source/inbox retention duration and purge evidence;
- real pathway handler expansion beyond the six observed anchors;
- missing domain emitters and which become required in-transaction anchors;
- all D3–D7 clinical policies;
- S1b generation promotion, projections, runtime, tasks/SLAs, workbench and active mode.

Until those are signed, the binding defaults are: retain everything, no event FK, no purge, six no-op observers only, all other events ignored, and default-off shadow execution.
