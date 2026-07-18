# Unified Care Pathways — S1a Lossless Event-Consumer Substrate Implementation Plan

> **Worker contract:** read this plan, its linked design, `docs/superpowers/build-prompts/_worker-common.md`, root `CLAUDE.md`, and `apps/backend/CLAUDE.md` in full before editing. Use a fresh worktree from current `github/main`, keep one scope to one PR, and stop after the PR opens with checks green.

**Goal:** Add a default-off, shadow/no-op Pathway projector inbox that losslessly records every retained `event_outbox` row once per generation, observes six verified in-transaction anchors, ignores every other event, and never changes webhook or clinical behavior.

**Architecture:** A new RLS-protected `pathway_projector_inbox` table is filled by a bounded floorless anti-join. Workers claim due rows with leases and `FOR UPDATE SKIP LOCKED`; attempts increment atomically on claim. Each row joins back to `event_outbox` on event id **and tenant id**, runs a generation-immutable no-op observer or records `ignored`, and CAS-commits the terminal result inside `setTenantTx`. Owner token plus attempt epoch fence every completion path. Failure/reaper schedules retry or dead-letter without incrementing attempts again. Replay always uses a new generation. Delivery is lossless but unordered.

**Tech stack:** Node ESM, PostgreSQL 17 raw-SQL migration, Prisma, Jest with real-Postgres deep tests, existing scheduler/advisory-lock and reliability-metrics infrastructure.

**Spec:** `docs/superpowers/specs/2026-07-18-unified-care-pathways-s1a-lossless-event-consumer-substrate-design.md`

**Grounding revision:** `f826fe09647667f76c0b3e8c0345876b70de4318`

## Non-negotiable implementation constraints

1. **No scan floor:** no cursor, watermark, count-equality optimization, or lower-bound predicate. Every materialization batch anti-joins all retained source rows.
2. **No source-status filter:** discovery does not read webhook `status`, `attempts`, `available_at`, or `delivered_at` as eligibility.
3. **No event FK and no purge:** `event_id` is a logical BIGINT link. Only `tenant_id` gets an FK. All rows/generations are retained.
4. **Exactly six handled types in generation 1:** handover create/acknowledge, prehospital handover create/accept, discharge-summary save/sign. All other events become `ignored`.
5. **Handled is not clinical closure:** observers are no-op and cannot write domain, workflow, timeline, audit, task, SLA, notification, WebSocket, or patient state.
6. **Immutable registry per generation:** any membership or semantic change requires a new generation.
7. **Attempt-on-claim:** claim increments once. Handler failure and reaper never increment again.
8. **Fail-closed relation:** terminal processing requires a source join on both event id and tenant id.
9. **BIGINT strings:** select ids with `::text`; accept strings and cast `::bigint`; never coerce event ids in JavaScript.
10. **Unordered:** tests must not assert processing order. Correctness is complete membership plus terminal uniqueness.
11. **Webhook isolation:** S1a may select from `event_outbox` but cannot call or modify the existing claim/drain/delivery path.
12. **Default off:** scheduler bodies do nothing unless `PATHWAY_PROJECTOR_SHADOW_ENABLED=true`; there is no active mode.
13. **D3–D7 excluded:** no clinical-policy implementation or placeholder.

## Preflight and migration reservation

- [ ] Confirm the implementation worktree is clean and based on the latest `github/main`.
- [ ] Confirm both S1a documents are present and reviewed in this worktree; they ship in the same slice PR.
- [ ] Confirm migration `578_*` is still reserved for this slice. The grounded tree ends at 577 but contains duplicate older prefixes; migration runners track the **full filename**, not a unique numeric prefix. If 578 has been assigned by the coordinator to another merged/in-flight scope, stop and obtain a new registered number.
- [ ] Read the current migration registry/build ledger before creating SQL; do not “ls and take” an unreserved number.
- [ ] Record start SHA, worktree, branch, reserved migration, database DSN name, and intended test commands in the build ledger.

## File structure

Create:

- `apps/backend/src/migrations/578_pathway_projector_inbox.sql`
- `apps/backend/src/services/events/pathwayProjectorRegistry.js`
- `apps/backend/src/services/events/pathwayProjectorService.js`
- `apps/backend/src/tests/unit/pathwayProjectorRegistry.test.js`
- `apps/backend/src/tests/pathway-event-delivery.deep.test.js`
- `apps/backend/src/tests/pathway-projector-replay.deep.test.js`

Modify:

- `apps/backend/prisma/schema.prisma` by `prisma db pull` from this worktree's scratch DB only
- `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md` to reserve migration 578 and refresh the already-landed 575–577 tail
- `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md` only for the unsafe scan-floor example and stale referral/lab emitter claim
- `apps/backend/src/utils/scheduler.js`
- `apps/backend/src/observability/reliabilityMetrics.js`
- `apps/backend/scripts/run-ci-jest.mjs` to isolate the multi-transaction/RLS deep tests
- `apps/backend/src/tests/event-outbox-drain-deep.test.js`
- existing reliability-metrics unit tests

Conditional:

- `apps/backend/scripts/seed-comprehensive-test-data.mjs` only if the comprehensive seeder proves a narrow override is required.

Forbidden in this slice:

- app/routes/OpenAPI/infra changes;
- domain service or producer edits;
- timeline, audit, workflow, task, SLA, notification, or patient/staff/admin UI changes;
- `event_outbox` or `webhook_deliveries` DDL/DML changes.

## Task 1: Immutable generation-1 registry

**Files:**

- Create `apps/backend/src/services/events/pathwayProjectorRegistry.js`.
- Create `apps/backend/src/tests/unit/pathwayProjectorRegistry.test.js`.

- [ ] **Step 1: Write the failing unit tests.**

Assert the generation-1 membership is exactly:

```text
clinical.handover.created
clinical.handover.acknowledged
clinical.prehospital_handover.created
clinical.prehospital_handover.accepted
clinical_document.discharge_summary.saved
clinical_document.discharge_summary.signed
```

Also assert:

- `order.created` and another current non-member resolve to no handler;
- duplicate event keys throw;
- empty/malformed event types and non-functions throw;
- returned registry/key collections are immutable;
- each observer returns only bounded shadow metadata and has no Prisma import.

- [ ] **Step 2: Run the unit test and require RED** because the registry module does not exist.

```powershell
cd apps/backend
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/pathwayProjectorRegistry.test.js --forceExit
```

- [ ] **Step 3: Implement the minimal registry.**

Export:

- `PATHWAY_PROJECTOR_CONSUMER_KEY = 'care_pathway_projector'`
- `PATHWAY_PROJECTOR_GENERATION = 1`
- immutable `PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES`
- `createPathwayProjectorRegistry({ generation, entries })`
- frozen production `pathwayProjectorRegistry`

The resolver returns a handler only for exact keys. Do not add prefixes, wildcards, `automation_rules`, mutable registration after construction, or last-write-wins `Map.set`.

“Handled” metadata should identify only consumer, generation, event type, and `shadow_observed: true`. It must not claim clinical action/closure.

- [ ] **Step 4: Run the unit test to GREEN, then lint the two files.**
- [ ] **Step 5: Commit only Task 1 files.**

Suggested commit: `feat(pathways): define immutable S1a shadow observer registry`

## Task 2: Migration 578 and Prisma model

**Files:**

- Create `apps/backend/src/migrations/578_pathway_projector_inbox.sql`.
- Regenerate `apps/backend/prisma/schema.prisma`.
- Conditionally modify the comprehensive seeder only after a demonstrated failure.

- [ ] **Step 1: Write migration 578.**

Required table shape:

```sql
CREATE TABLE pathway_projector_inbox (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  consumer_key VARCHAR(120) NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  event_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'handled', 'ignored', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ(6),
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  last_error TEXT,
  outcome_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer_key, generation, event_id),
  CONSTRAINT fk_pathway_projector_inbox_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_pathway_projector_inbox_lease_pair
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
```

Add:

- global-worker pending index `(consumer_key, generation, next_attempt_at, event_id) WHERE status='pending' AND lease_owner IS NULL`;
- global-worker stale index `(consumer_key, generation, lease_expires_at, event_id) WHERE status='pending' AND lease_owner IS NOT NULL`;
- operational tenant index `(tenant_id, consumer_key, generation, status, event_id)`;
- ENABLE and FORCE RLS;
- `tenant_isolation` with the exact Pattern-A `USING` and `WITH CHECK`.

Do **not** add:

- FK to `event_outbox`;
- trigger/update/delete guard outside the specified model;
- generation/current table;
- scan floor/watermark;
- retention/purge function.

- [ ] **Step 2: Build a disposable scratch database from this worktree's migrations.**

Follow `_worker-common.md`: create DB, install `vector` and `pg_trgm`, run `scripts/ci-setup-db.mjs`, and never pull Prisma from shared QA/dev.

- [ ] **Step 3: Regenerate and commit Prisma from that scratch DB.**

```powershell
cd apps/backend
$env:DATABASE_URL = '<scratch-dsn>'
npx prisma db pull --schema=prisma/schema.prisma
npx prisma generate --schema=prisma/schema.prisma
node scripts/check-schema-drift.mjs
node scripts/check-phi-tenant-id.mjs
```

Verify Prisma maps the composite key, BIGINT event id, tenant relation, timestamps, and indexes. Never hand-edit generated model fields.

- [ ] **Step 4: Run migration smoke and comprehensive seed.**

Require fresh apply, rerun, tracker-rebuild paths, and `"failed": []`. Add a seeder override only if the actual failure identifies a mandatory checked column; keep the override in this task's commit.

- [ ] **Step 5: Commit migration, generated schema, and any proven seeder adjustment together.**

Suggested commit: `feat(pathways): add RLS projector inbox ledger`

## Task 3: Floorless materializer and BIGINT contract

**Files:**

- Create the discovery portion of `apps/backend/src/services/events/pathwayProjectorService.js`.
- Start `apps/backend/src/tests/pathway-event-delivery.deep.test.js`.

- [ ] **Step 1: Write failing deep tests for floorless discovery.**

Cover:

- one retained outbox row creates one inbox row;
- repeated and concurrent materialization leaves one row;
- source rows in `pending`, `processing`, `delivered`, and `failed` are all eligible;
- a bounded first batch is followed by a later batch that finds remaining lower/higher ids;
- `9007199254740993` round-trips exactly as a string;
- tenant id is copied from the source.

- [ ] **Step 2: Add the deterministic inverted-commit-order proof.**

Use two explicit DB transactions:

1. A begins, inserts and captures lower id, but does not commit.
2. B begins after A's insert, inserts higher id, commits.
3. Materializer sees/records B.
4. A commits.
5. Next materializer run sees/records A.

Coordinate with explicit promises/barriers or database notifications. Do not use sleeps and do not assert processing order.

- [ ] **Step 3: Implement `materializeMissingInboxRows`.**

Requirements:

- exact floorless anti-join from the design;
- no source-status/time/id-floor predicate;
- bounded limit 1–200;
- `ON CONFLICT DO NOTHING`;
- return `event_id::text` and `tenant_id::text`;
- use spread raw parameters;
- execute under scheduler super-admin context and copy `tenant_id` explicitly.

- [ ] **Step 4: Run the new deep subset to GREEN.**
- [ ] **Step 5: Run static scans.**

```powershell
rg -n "scan_floor|high_water|event_consumer_offsets|COUNT\(.*inbox" apps/backend/src/services/events/pathwayProjectorService.js apps/backend/src/migrations/578_pathway_projector_inbox.sql
rg -n "REFERENCES\s+event_outbox|DELETE\s+FROM\s+pathway_projector_inbox" apps/backend/src/migrations/578_pathway_projector_inbox.sql apps/backend/src/services/events/pathwayProjectorService.js
```

Expected: no matches.

- [ ] **Step 6: Commit Task 3.**

Suggested commit: `feat(pathways): materialize floorless projector inbox`

## Task 4: Claim, tenant processing, retries, and reaper

**Files:**

- Complete `apps/backend/src/services/events/pathwayProjectorService.js`.
- Extend `apps/backend/src/tests/pathway-event-delivery.deep.test.js`.

- [ ] **Step 1: Write failing deep tests for claim/process lifecycle.**

Cover:

- concurrent claimers get disjoint rows;
- claim sets owner/expiry and increments attempts exactly once;
- one six-anchor event becomes `handled`;
- one non-member domain event becomes `ignored`;
- handled/ignored observers create no non-inbox rows;
- source join requires event id plus tenant id;
- missing/mismatched source fails closed;
- handler failure schedules backoff without incrementing attempts again;
- expired lease reaper schedules retry without incrementing;
- seventh claim/failure or seventh stale claim becomes `dead`;
- an owner may finish after the timestamp passes but before reaping, while an old owner cannot finish after reaping/reclaim replaces its token;
- terminal rows cannot be reclaimed or mutated;
- tenant A cannot see/claim/finish tenant B with RLS enforced.

- [ ] **Step 2: Implement `claimDueInboxRows`.**

Use a locked CTE and atomic update:

```sql
WITH due AS (
  SELECT consumer_key, generation, event_id
  FROM pathway_projector_inbox
  WHERE consumer_key = $1
    AND generation = $2::integer
    AND status = 'pending'
    AND next_attempt_at <= NOW()
    AND lease_owner IS NULL
  ORDER BY next_attempt_at, event_id
  FOR UPDATE SKIP LOCKED
  LIMIT $3
)
UPDATE pathway_projector_inbox i
SET lease_owner = $4::uuid,
    lease_expires_at = NOW() + ($5::integer * INTERVAL '1 second'),
    attempts = i.attempts + 1
FROM due
WHERE i.consumer_key = due.consumer_key
  AND i.generation = due.generation
  AND i.event_id = due.event_id
RETURNING i.event_id::text, i.tenant_id::text, i.attempts;
```

SQL ordering is only a fairness choice, not a delivery-order contract.

- [ ] **Step 3: Implement `processClaimedInboxRow`.**

Inside `setTenantTx(tenantId, ...)`:

- select/lock inbox and join source on `e.id=i.event_id AND e.tenant_id=i.tenant_id`;
- require matching owner token and `pending`; do not predicate processing on wall-clock expiry;
- carry source id as text;
- resolve the immutable registry;
- invoke no-op observer or choose `ignored`;
- CAS terminal update with the matching owner token, without a wall-clock expiry predicate;
- clear lease, clear error, and set `outcome_at`.

On missing/mismatched source, throw a bounded internal error. Do not terminally ignore it.

- [ ] **Step 4: Implement failure and reaper transitions.**

Use the six retry delays from the design, then make the seventh failed claim terminal `dead` without scheduling another retry. Failure/reaper must inspect the already-incremented `attempts`; neither increments it. Clear the owner token and expiry and schedule `next_attempt_at`, or set `dead` at the cap. Reaping is what revokes an expired claim; until then the owner may still finish. Fence processing, failure, terminal CAS, and reaping on both owner token and attempt epoch so deliberate UUID reuse cannot revive stale work. Truncate/sanitize `last_error`; never include payload, patient uid, aggregate id, SQL, or stack.

- [ ] **Step 5: Run the complete lossless deep suite to GREEN and lint the service.**
- [ ] **Step 6: Commit Task 4.**

Suggested commit: `feat(pathways): lease and fence shadow projector work`

## Task 5: Replay, runner, scheduler, and metrics

**Files:**

- Create `apps/backend/src/tests/pathway-projector-replay.deep.test.js`.
- Modify `apps/backend/src/services/events/pathwayProjectorService.js`.
- Modify `apps/backend/src/utils/scheduler.js`.
- Modify `apps/backend/src/observability/reliabilityMetrics.js` and its unit tests.
- Modify `apps/backend/scripts/run-ci-jest.mjs` so the multi-transaction/RLS deep tests run in the isolated group.

- [ ] **Step 1: Write replay tests before runner wiring.**

Prove generation 2 gets a fresh terminal row for every retained source, generation 1 stays byte-identical, reruns do not duplicate, and a changed registry fixture is allowed only with a new generation.

- [ ] **Step 2: Implement `runPathwayProjectorShadowTick`.**

The runner:

- receives registry/consumer/generation explicitly;
- materializes batches until empty or `maxBatches`;
- claims one bounded batch with a fresh UUID worker id;
- processes rows independently so one poison row does not abort others;
- returns only `{ materialized, claimed, handled, ignored, retried, dead }`;
- makes no ordering guarantee.

- [ ] **Step 3: Add default-off scheduler jobs using dynamic imports.**

Near the existing outbox drain:

- every two minutes, job key `pathway-projector-shadow`;
- every five minutes, job key `pathway-projector-stale-lease-reaper`;
- both check `PATHWAY_PROJECTOR_SHADOW_ENABLED` and return before import unless it is case-insensitive `true`;
- use existing `registerCron` / `withJobLock`;
- do not add startup execution or an active mode.

- [ ] **Step 4: Add reliability gauges and unit coverage.**

Add:

- `pathway_projector_inbox_pending_rows`
- `pathway_projector_inbox_oldest_pending_age_seconds`
- `pathway_projector_inbox_leased_rows`
- `pathway_projector_inbox_dead_rows`

Keep labels low-cardinality and avoid new eager imports. Update existing mocked query results/assertions in both reliability-metrics unit suites.

- [ ] **Step 5: Sweep scheduler mock consumers.**

At minimum rerun:

- `event-outbox-drain-deep.test.js`
- `notificationOutboxDrain.deep.test.js`
- `schedulerAdvisoryLock.deep.test.js`
- `unit/auditChainVerificationJob.test.js`

Dynamic imports should keep the new service outside the eager graph.

- [ ] **Step 6: Run replay, registry, metrics, and scheduler-targeted suites to GREEN.**
- [ ] **Step 7: Commit Task 5.**

Suggested commit: `feat(pathways): schedule observable shadow projector`

## Task 6: Webhook coexistence and complete exit evidence

**Files:**

- Modify `apps/backend/src/tests/event-outbox-drain-deep.test.js`.
- Complete both new deep suites.

- [ ] **Step 1: Add the coexistence regression.**

For a unique event:

1. Snapshot source `status`, `attempts`, `available_at`, `last_error`, `delivered_at`.
2. Count matching `webhook_deliveries`.
3. Run materialize/claim/process.
4. Assert source snapshot and delivery count are unchanged.
5. Run existing webhook drain once.
6. Assert prior enqueue/delivery behavior and exact BIGINT bridge still pass.

- [ ] **Step 2: Complete the S1a matrix.**

Require explicit passing cases for:

- inverted commit order;
- duplicate materialization;
- two-worker race;
- crash boundary;
- stale lease and stale-worker fencing;
- attempt-on-claim/no double-increment;
- dead-letter cap;
- tenant isolation/RLS;
- missing bounded work recovery;
- source missing/mismatch fail-closed;
- BIGINT above safe integer;
- generation replay/immutability;
- six handled types vs every other ignored;
- webhook drain unchanged;
- no ordering assumption.

- [ ] **Step 3: Prove the no-op boundary.**

Capture counts for representative workflow/task/SLA/notification/pathway tables before/after the six observers, or use a transaction-scoped audit query, and assert no changes. Also scan the service imports: it must not import domain, task, SLA, notification, timeline, audit, WebSocket, or portal writers.

- [ ] **Step 4: Run all targeted tests with the implementation scratch DB.**

```powershell
cd apps/backend
$env:DATABASE_URL = '<scratch-dsn>'
$env:NODE_ENV = 'test'
node --experimental-vm-modules node_modules/jest/bin/jest.js `
  src/tests/unit/pathwayProjectorRegistry.test.js `
  src/tests/pathway-event-delivery.deep.test.js `
  src/tests/pathway-projector-replay.deep.test.js `
  src/tests/event-outbox-drain-deep.test.js `
  src/tests/unit/reliabilityMetrics.test.js `
  src/tests/unit/reliabilityMetricsReadReplicaLag.test.js `
  --forceExit
```

- [ ] **Step 5: Commit Task 6.**

Suggested commit: `test(pathways): prove S1a losslessness and webhook coexistence`

## Task 7: Full gates and PR delivery

- [ ] **Step 1: Rebuild the scratch DB from zero and rerun migration/seeder/schema gates.**

Require:

- migrations fresh-apply and rerun;
- Prisma generated from this worktree only;
- `check-schema-drift` clean;
- `check-phi-tenant-id` clean;
- comprehensive seed summary `"failed": []`;
- database contracts green.

- [ ] **Step 2: Run backend static gates.**

```powershell
npm --prefix apps/backend run lint
npm --prefix apps/backend run check:schema-drift
npm --prefix apps/backend run openapi:check
npm --prefix apps/backend run openapi:check-core
```

OpenAPI files should remain unchanged.

- [ ] **Step 3: Run the authoritative full backend Jest gate.**

```powershell
$env:DATABASE_URL = '<scratch-dsn>'
$env:NODE_ENV = 'test'
node apps/backend/scripts/run-ci-jest.mjs
```

Require the final `All chunks passed` summary and zero `FAIL src/`.

- [ ] **Step 4: Run final invariant scans.**

Confirm:

- no `scan_floor`, cursor or watermark;
- no event FK or delete/purge;
- no source outbox DML from S1a;
- exactly six generation-1 keys;
- no producer/domain/UI/API changes;
- all event ids remain strings at JS boundaries;
- `PATHWAY_PROJECTOR_SHADOW_ENABLED` defaults off;
- git diff contains only the planned files.

- [ ] **Step 5: Open one PR and stop.**

PR title:

```text
Care Pathways S1a: lossless shadow event-consumer substrate
```

PR build ledger must include:

- base and head SHA;
- migration 578;
- exact schema/RLS/retention/link invariants;
- exact six handled event types and definition of handled;
- statement that all other events are ignored and delivery is unordered;
- exact commands and pass counts;
- scratch DB name and successful cleanup;
- webhook coexistence result;
- all deferred S1b/emitter/retention/D3–D7 work.

Push the branch, open the PR, wait for checks, and **STOP**. Do not merge or push more commits after the PR opens; hand any later fix to the coordinator.

## Self-review

- **Spec coverage:** migration/RLS → Task 2; immutable registry/six no-op observers → Task 1; floorless anti-join/BIGINT/inverted commit → Task 3; leases/CAS/retry/reaper/fail-closed join → Task 4; replay/default-off scheduler/metrics → Task 5; webhook/no-op/full evidence → Task 6; authoritative gates/delivery → Task 7.
- **No scope leakage:** no S1b runtime, projection, workflow, task, SLA, notification, emitter, UI, route, OpenAPI, infra, retention purge, D3–D7, D8, or D9 implementation.
- **Correctness:** no floor exists; delivery is complete but unordered; attempts increment only on claim; terminal writes are owner/lease fenced; registry meaning is generation-scoped; event+tenant source relation fails closed.
- **Coexistence:** source outbox state and webhook delivery remain separately owned and regression-proven.
- **Operational safety:** default off, bounded batches, advisory locks, dynamic imports, PHI-free telemetry, retained evidence.
- **No unresolved build decision:** retention and additional handlers/emitters remain deferred under safe no-purge/no-handler defaults.
