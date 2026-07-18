# Unified Care Pathways — S1a Lossless Event-Consumer Substrate Implementation Plan

> **Worker contract:** read this plan, its linked design, `docs/superpowers/build-prompts/_worker-common.md`, root `CLAUDE.md`, and `apps/backend/CLAUDE.md` in full before editing. Use a fresh worktree from current `github/main`, keep one scope to one PR, and stop after the PR opens with checks green.

**Goal:** Add a default-off, shadow/no-op Pathway projector inbox that losslessly records each committed `event_outbox` event in the sole live generation, replays retained history into each fresh higher generation at handoff, observes six verified in-transaction anchors, dispatches every other processed event as `ignored`, and never changes webhook or clinical behavior.

**Architecture:** Migration 578 creates a global `event_consumer_offsets` registration/backfill/lifecycle table, an RLS-protected tenant-inclusive `pathway_projector_inbox`, and a hardened commit-coupled `AFTER INSERT` fanout trigger. The first enabled tick registers the sole live-intake generation behind a `SHARE ROW EXCLUSIVE` boundary, captures a fixed historical cutoff, and keyset-backfills that immutable range with a persistent cursor; later events fan out only to that non-retired generation. Replay is a lock-fenced handoff to a fresh higher generation after historical backfill completes. The scheduled runner claims one row only when its dispatch slot is ready. Each row joins back to `event_outbox` on event id **and tenant id**, runs a generation-immutable no-op observer or records `ignored`, and CAS-commits the terminal result inside `setTenantTx`. Delivery is lossless but unordered.

**Tech stack:** Node ESM, PostgreSQL 17 raw-SQL migration, Prisma, Jest with real-Postgres deep tests, existing scheduler/advisory-lock and reliability-metrics infrastructure.

**Spec:** `docs/superpowers/specs/2026-07-18-unified-care-pathways-s1a-lossless-event-consumer-substrate-design.md`

**Grounding revision:** `f826fe09647667f76c0b3e8c0345876b70de4318`

## Non-negotiable implementation constraints

1. **No scalar live cursor:** `event_consumer_offsets.backfill_cursor_event_id` is only persistent keyset progress through a fixed registration cutoff. Live completeness comes from commit-coupled trigger fanout; no count-equality or live watermark shortcut is allowed.
2. **No source-status filter:** discovery does not read webhook `status`, `attempts`, `available_at`, or `delivered_at` as eligibility.
3. **No event FK or destructive purge:** `event_id` is a logical BIGINT link. Only `tenant_id` gets an FK. Lifecycle retirement retains every offset/inbox row; deletion remains owner-gated.
4. **Exactly six handled types in generation 1:** handover create/acknowledge, prehospital handover create/accept, discharge-summary save/sign. Every other dispatched event becomes `ignored`.
5. **Handled is not clinical closure:** observers are no-op and cannot write domain, workflow, timeline, audit, task, SLA, notification, WebSocket, or patient state.
6. **Immutable registry per generation:** any membership or semantic change requires a new generation.
7. **Attempt-on-claim:** claim increments once. Handler failure and reaper never increment again.
8. **Tenant-inclusive identity:** inbox PK/conflict/claim/reaper/CAS paths include `tenant_id`; terminal processing also requires a source join on both event id and tenant id.
9. **BIGINT strings:** select ids with `::text`; accept strings and cast `::bigint`; never coerce event ids in JavaScript.
10. **Unordered:** tests must not assert processing order. Correctness is complete membership plus terminal uniqueness.
11. **Webhook isolation:** trigger/backfill copy source identity but never mutate webhook-owned source fields or call the existing claim/drain/delivery path.
12. **True default off, durable after registration:** migration seeds no generation. The first enabled tick registers it. Later disabling pauses processing/reaping but does not retire the live-intake row; trigger intake continues so re-enabling drains the backlog.
13. **Claim on dispatch:** the scheduled runner has one slot, claims only when ready, and leaves queued rows unleased with attempts unchanged. `maxBatches × claimLimit` is a safety cap, not a throughput promise.
14. **Generation lifecycle:** one partial-unique non-retired offset per consumer; handoff requires completed historical backfill, atomically retires old/registers fresh higher under the table lock, and never reactivates a retired generation. Zero old pending is recommended cutover evidence, not a database precondition; residual debt remains finite and observable.
15. **Generation-scoped telemetry:** operational metrics filter the configured consumer/current generation; a dedicated retired-generation pending gauge exposes residual debt and all replay evidence remains queryable.
16. **Decision gates:** D1 is adopted for S1a. D2 remains unresolved and gates S1b. D8/D9 remain unresolved and gate only their named later integrations. D3–D7 keep their pathway-slice gates.
17. **Definer trust boundary:** migration 578 must reject colliding relation/index/function names with an unexpected owner, kind, or trigger-function shape before installing the definer. The function uses only `pg_catalog, pg_temp` search paths plus a catalog-qualified operator guard; deployment and boot provisioning keep schema `public` non-creatable by `PUBLIC` and runtime/application roles and re-revoke direct function execution.

## Preflight and migration reservation

- [ ] Confirm the implementation worktree is clean and based on the latest `github/main`.
- [ ] Confirm both S1a documents are present and reviewed in this worktree; they ship in the same slice PR.
- [ ] Confirm migration `578_*` is reserved for this slice. S1a consumes 578; **579 is next-free at this revision**. The two existing 574 filenames remain an independently tracked collision and neither prefix may ever be reused. If 578 has been assigned elsewhere, stop and obtain a new registered number.
- [ ] Read the current migration registry/build ledger before creating SQL; do not “ls and take” an unreserved number.
- [ ] Record start SHA, worktree, branch, reserved migration, database DSN name, and intended test commands in the build ledger.

## File structure

Create:

- `apps/backend/src/migrations/578_pathway_projector_inbox.sql`
- `apps/backend/src/config/pathwayProjectorConfig.js`
- `apps/backend/src/services/events/pathwayProjectorRegistry.js`
- `apps/backend/src/services/events/pathwayProjectorService.js`
- `apps/backend/src/tests/unit/pathwayProjectorConfig.test.js`
- `apps/backend/src/tests/unit/pathwayProjectorSchedulerWiring.test.js`
- `apps/backend/src/tests/unit/pathwayProjectorRegistry.test.js`
- `apps/backend/src/tests/pathway-event-delivery.deep.test.js`
- `apps/backend/src/tests/pathway-projector-replay.deep.test.js`

Modify:

- `apps/backend/prisma/schema.prisma` by `prisma db pull` from this worktree's scratch DB only
- `apps/backend/.env.example`
- `apps/backend/src/lib/prisma.js` to re-revoke public-schema `CREATE` and trigger-function execution after boot-time role grants
- `infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql` to remove public-schema `CREATE` from `PUBLIC` and the provisioned application/runtime roles
- `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md` to reserve migration 578 and refresh the already-landed 575–577 tail
- `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md` only for the unsafe scan-floor example and stale referral/lab emitter claim
- `apps/backend/src/utils/scheduler.js`
- `apps/backend/src/utils/validateEnv.js`
- `apps/backend/src/observability/reliabilityMetrics.js`
- `apps/backend/scripts/run-ci-jest.mjs` to isolate the multi-transaction/RLS deep tests
- `apps/backend/src/tests/event-outbox-drain-deep.test.js`
- existing reliability-metrics unit tests
- `apps/backend/src/tests/unit/prismaCoverage.test.js`

Conditional:

- `apps/backend/scripts/seed-comprehensive-test-data.mjs` only if the comprehensive seeder proves a narrow override is required.

Forbidden in this slice:

- app/routes/OpenAPI changes or infra changes beyond the named Dalekdefender runtime-role SQL;
- domain service or producer edits;
- timeline, audit, workflow, task, SLA, notification, or patient/staff/admin UI changes;
- source-column or `webhook_deliveries` DDL/DML changes; the migration-installed `event_outbox` `AFTER INSERT` trigger is the sole allowed outbox DDL.

## Task 1: Immutable generation-1 registry

**Files:**

- Create `apps/backend/src/config/pathwayProjectorConfig.js`.
- Create `apps/backend/src/tests/unit/pathwayProjectorConfig.test.js`.
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

- the config exports consumer `care_pathway_projector`, current generation `1`, and resolves only a
  trimmed case-insensitive `true` flag as enabled (undefined/empty/false stay off);
- `order.created` and another current non-member resolve to no handler;
- duplicate event keys throw;
- empty/malformed event types and non-functions throw;
- returned registry/key collections are immutable;
- each observer returns only bounded shadow metadata and has no Prisma import.

- [ ] **Step 2: Run both unit tests and require RED** because the config/registry modules do not exist.

```powershell
cd apps/backend
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/pathwayProjectorConfig.test.js src/tests/unit/pathwayProjectorRegistry.test.js --forceExit
```

- [ ] **Step 3: Implement the minimal registry.**

Export consumer/generation constants and `isPathwayProjectorShadowEnabled` from the config module.
Import/re-export the constants from the registry, which also exports:

- immutable `PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES`
- `createPathwayProjectorRegistry({ generation, entries })`
- frozen production `pathwayProjectorRegistry`

The resolver returns a handler only for exact keys. Do not add prefixes, wildcards, `automation_rules`, mutable registration after construction, or last-write-wins `Map.set`.

“Handled” metadata should identify only consumer, generation, event type, and `shadow_observed: true`. It must not claim clinical action/closure.

- [ ] **Step 4: Run both unit tests to GREEN, then lint all four files.**
- [ ] **Step 5: Commit only Task 1 files.**

Suggested commit: `feat(pathways): define immutable S1a shadow observer registry`

## Task 2: Migration 578 and Prisma model

**Files:**

- Create `apps/backend/src/migrations/578_pathway_projector_inbox.sql`.
- Regenerate `apps/backend/prisma/schema.prisma`.
- Modify `apps/backend/src/lib/prisma.js`.
- Modify `apps/backend/src/tests/unit/prismaCoverage.test.js`.
- Modify `infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql`.
- Conditionally modify the comprehensive seeder only after a demonstrated failure.

- [ ] **Step 1: Write migration 578.**

Create global non-PHI `event_consumer_offsets`, keyed by `(consumer_key, generation)`, with positive
generation, fixed `historical_cutoff_event_id`, persistent `backfill_cursor_event_id`,
`backfill_completed_at`, nullable `intake_retired_at`, `registered_at`, and `updated_at`. Add
bounds/completion checks so the cursor cannot pass the cutoff or claim completion before reaching it,
plus `uq_event_consumer_offsets_live_consumer`, a partial unique index permitting exactly one
`intake_retired_at IS NULL` row per consumer. **Do
not seed generation 1 in the migration.** Retirement checks require completed backfill and retirement
chronology at/after registration.

Create `pathway_projector_inbox` with the columns/status/lease checks in the design and primary key:

```sql
PRIMARY KEY (tenant_id, consumer_key, generation, event_id)
```

Add:

- pending index `(consumer_key, generation, next_attempt_at, event_id) WHERE status='pending' AND lease_owner IS NULL`;
- stale index `(consumer_key, generation, lease_expires_at, event_id) WHERE status='pending' AND lease_owner IS NOT NULL`;
- operational tenant index `(tenant_id, consumer_key, generation, status, event_id)`;
- metrics index `(consumer_key, generation, status, created_at) INCLUDE (lease_owner) WHERE status IN ('pending','dead')`;
- tenant FK, ENABLE and FORCE RLS, and exact Pattern-A `USING` / `WITH CHECK`;
- hardened, relation/operation-bound `SECURITY DEFINER` function `pathway_projector_enqueue_new_event()`
  with `search_path = pg_catalog, pg_temp`, schema-qualified application relations, a catalog-qualified
  `OPERATOR(pg_catalog.<>)` relation/operation guard, and execute revoked, installed as the same-named
  `AFTER INSERT` trigger on `event_outbox`;
- fanout only to the consumer's sole `intake_retired_at IS NULL` generation using
  `ON CONFLICT (tenant_id, consumer_key, generation, event_id) DO NOTHING`;
- an unchanged `NEW` return and no source/webhook field mutation.

At migration entry, revoke schema-`public` `CREATE` from `PUBLIC` and any existing `vhhealth_app` /
`vhhealth_runtime` roles, then fail if any still retain it. Before the definer is created, resolve any
pre-existing `event_consumer_offsets`, `pathway_projector_inbox`, and `event_outbox` object through
`pg_catalog` and abort unless its `relkind = 'r'` and `relowner = CURRENT_USER`. The migration must not
attach trusted trigger behavior to an attacker-controlled lookalike. Apply the same fail-closed rule to
each new named index (`relkind = 'i'`, current owner) and to a colliding zero-argument
`pathway_projector_enqueue_new_event` (current owner, function kind, `trigger` return type) before using
`IF NOT EXISTS` or `OR REPLACE`.

Migration revokes direct trigger-function execution from `PUBLIC` and known runtime roles. Update
`infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql` so `PUBLIC`, `vhhealth_app`, and
`vhhealth_runtime` have `USAGE` but not `CREATE` on schema `public`. Extend
`apps/backend/src/lib/prisma.js` so boot-time role/default-function grants immediately re-revoke
schema `CREATE` from `PUBLIC` and the configured application role and re-revoke this specific function;
pin both invariants in `prismaCoverage.test.js`.

Do **not** add an FK to `event_outbox`, generation seed, live scalar watermark, or destructive retention/
purge function.

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

Verify Prisma maps both tables, the tenant-inclusive composite key, BIGINT ids/cursors, tenant relation, timestamps, and indexes. Never hand-edit generated model fields.

- [ ] **Step 4: Run migration smoke, comprehensive seed, and Prisma boot-privilege coverage.**

Require canonical-runner fresh apply, rerun, tracker-rebuild paths, an explicitly recorded 578, no
connection `search_path` drift before/after apply, `"failed": []`, and a green
`src/tests/unit/prismaCoverage.test.js`. Add dynamic migration-negative cases for a wrong-owner table,
an index-name collision, and a zero-argument function owner collision; each must prove the migration
fails and no projector trigger is installed on `event_outbox`. Post-migration catalog inspection is not
a substitute. Verify both
the Dalekdefender SQL and the generated Prisma boot SQL remove schema `CREATE`, and that boot SQL
re-revokes direct trigger-function execution. Add a seeder override only if the actual failure identifies
a mandatory checked column; keep the override in this task's commit.

- [ ] **Step 5: Commit migration, generated schema, Dalekdefender role hardening, Prisma boot re-revoke/test, and any proven seeder adjustment together.**

Suggested commit: `feat(pathways): add registered projector inbox ingestion`

## Task 3: Race-free registration, trigger fanout, bounded backfill, and BIGINT contract

**Files:**

- Create the discovery portion of `apps/backend/src/services/events/pathwayProjectorService.js`.
- Start `apps/backend/src/tests/pathway-event-delivery.deep.test.js`.

- [ ] **Step 1: Write failing deep tests for registration and ingestion.**

Cover:

- migration seeds no registration, so a never-enabled deployment receives no S1a fanout;
- first enabled registration takes a `SHARE ROW EXCLUSIVE` boundary and persists one fixed cutoff;
- registration waits for a pre-existing uncommitted insert and includes it below the cutoff;
- a committed post-registration insert atomically creates one inbox row while a rolled-back insert creates none;
- repeated/concurrent trigger and backfill overlap leaves one tenant-scoped row;
- source rows in `pending`, `processing`, `delivered`, and `failed` are all eligible;
- bounded backfill persists its cursor and a later run resumes the remaining fixed-cutoff history;
- the cursor advances to the last source row scanned when every inbox insert conflicts and materialized count is zero;
- an explicit post-cursor low id is still captured by the trigger;
- a wrong-tenant row cannot poison/suppress the correct tenant's inbox row;
- exactly one non-retired generation exists per consumer and only it receives trigger fanout;
- handoff to a fresh higher generation fails atomically while the prior historical backfill is incomplete;
- successful handoff retires old/registers new at one cutoff even if a finite old pending residual races
  the planned zero-pending cutover evidence; that debt remains visible and receives no new trigger rows;
- a retired generation cannot be reactivated;
- `9007199254740993` round-trips exactly as a string;
- tenant id is copied from the source.

- [ ] **Step 2: Add the deterministic registration-boundary proof.**

Use two explicit DB transactions:

1. A begins, inserts and captures a lower id, but does not commit.
2. Registration starts and blocks on `SHARE ROW EXCLUSIVE`.
3. A commits; registration acquires the lock, captures a cutoff containing A, persists the generation,
   and commits.
4. B inserts after registration (including a case with an explicit id below the later backfill cursor)
   and is commit-coupled into the inbox by the trigger.
5. Bounded backfill records A without depending on trigger delivery for pre-registration history.

Coordinate with explicit promises/barriers or database notifications. Do not use sleeps and do not assert processing order.

- [ ] **Step 3: Implement registration and `materializeMissingInboxRows`.**

Requirements:

- registration begins with `LOCK TABLE event_outbox IN SHARE ROW EXCLUSIVE MODE`, rechecks for an
  existing `(consumer_key,generation)` and the sole active consumer row, then either creates the first
  generation or performs a fresh-higher-generation handoff;
- handoff requires the prior `backfill_completed_at`, stamps its `intake_retired_at`, captures committed
  `MAX(id)` as the new fixed cutoff, and inserts the new generation in the same transaction;
- an incomplete-backfill or retired/same-or-lower-generation request throws without lifecycle mutation;
- zero prior pending is recommended operational cutover evidence, not a database precondition;
- backfill locks the registration row and keyset-scans only
  `backfill_cursor_event_id < e.id AND e.id <= historical_cutoff_event_id`;
- inbox inserts and cursor advance share one transaction; progress advances by the last source row
  scanned even when inserts conflict;
- every conflict key includes tenant id;
- no source-status/time predicate and no use of the historical cursor for live ingestion;
- bounded limit 1–200;
- tenant-inclusive `ON CONFLICT DO NOTHING`;
- return `event_id::text` and `tenant_id::text`;
- use spread raw parameters;
- execute under scheduler super-admin context and copy `tenant_id` explicitly.

- [ ] **Step 4: Run the new deep subset to GREEN.**
- [ ] **Step 5: Run static scans.**

```powershell
rg -n "historical_cutoff_event_id|backfill_cursor_event_id|intake_retired_at|SHARE ROW EXCLUSIVE|AFTER INSERT|pathway_projector_enqueue_new_event" apps/backend/src/services/events/pathwayProjectorService.js apps/backend/src/migrations/578_pathway_projector_inbox.sql
rg -n "REFERENCES\s+event_outbox|DELETE\s+FROM\s+(event_consumer_offsets|pathway_projector_inbox)|UPDATE\s+event_outbox" apps/backend/src/migrations/578_pathway_projector_inbox.sql apps/backend/src/services/events/pathwayProjectorService.js
```

Expected: the first scan proves the boundary/cursor/trigger substrate; the second has no matches.

- [ ] **Step 6: Commit Task 3.**

Suggested commit: `feat(pathways): register and backfill projector inbox`

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
  SELECT tenant_id, consumer_key, generation, event_id
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
  AND i.tenant_id = due.tenant_id
  AND i.event_id = due.event_id
RETURNING i.event_id::text, i.tenant_id::text, i.attempts;
```

SQL ordering is only a fairness choice, not a delivery-order contract.

- [ ] **Step 3: Implement `processClaimedInboxRow`.**

Inside `setTenantTx(tenantId, ...)`:

- select/lock inbox by the full tenant-inclusive PK and join source on `e.id=i.event_id AND e.tenant_id=i.tenant_id`;
- require matching owner token and `pending`; do not predicate processing on wall-clock expiry;
- carry source id as text;
- resolve the immutable registry;
- invoke no-op observer or choose `ignored`;
- CAS terminal update with tenant id, consumer, generation, event id, attempt epoch, and matching owner token, without a wall-clock expiry predicate;
- clear lease, clear error, and set `outcome_at`.

On missing/mismatched source, throw a bounded internal error. Do not terminally ignore it.

- [ ] **Step 4: Implement failure and reaper transitions.**

Use the six retry delays from the design, then make the seventh failed claim terminal `dead` without scheduling another retry. Failure/reaper must inspect the already-incremented `attempts`; neither increments it. Clear the owner token and expiry and schedule `next_attempt_at`, or set `dead` at the cap. Reaping is what revokes an expired claim; until then the owner may still finish. Every failure/reaper mutation carries tenant id plus consumer/generation/event identity. Fence processing, failure, terminal CAS, and reaping on both owner token and attempt epoch so deliberate UUID reuse cannot revive stale work. Truncate/sanitize `last_error`; never include payload, patient uid, aggregate id, SQL, or stack.

- [ ] **Step 5: Run the complete lossless deep suite to GREEN and lint the service.**
- [ ] **Step 6: Commit Task 4.**

Suggested commit: `feat(pathways): lease and fence shadow projector work`

## Task 5: Replay, runner, scheduler, and metrics

**Files:**

- Create `apps/backend/src/tests/pathway-projector-replay.deep.test.js`.
- Use `apps/backend/src/config/pathwayProjectorConfig.js` and its unit test from Task 1.
- Modify `apps/backend/src/services/events/pathwayProjectorService.js`.
- Modify `apps/backend/.env.example` and `apps/backend/src/utils/validateEnv.js`.
- Modify `apps/backend/src/utils/scheduler.js`.
- Create `apps/backend/src/tests/unit/pathwayProjectorSchedulerWiring.test.js`.
- Modify `apps/backend/src/observability/reliabilityMetrics.js` and its unit tests.
- Modify `apps/backend/scripts/run-ci-jest.mjs` so the multi-transaction/RLS deep tests run in the isolated group.

- [ ] **Step 1: Write replay tests before runner wiring.**

Prove generation 2 handoff fails atomically until generation 1 historical backfill completes; then one
lock-fenced transaction retires generation 1 and registers generation 2 at its own cutoff/cursor.
Pre-cutover history is backfilled into generation 2, post-cutover inserts fan out only to generation 2,
and any generation-1 pending residual remains finite/observable rather than blocking liveness. Reruns do
not duplicate, generation 1 cannot be reactivated, and changed registry membership requires a fresh
higher generation.

- [ ] **Step 2: Implement `runPathwayProjectorShadowTick`.**

The runner:

- receives registry/consumer/generation explicitly;
- calls `registerEventConsumer` idempotently before backfill/processing;
- materializes fixed-cutoff keyset pages until complete or `maxBatches`;
- computes `maxBatches × claimLimit` as a per-tick safety budget;
- claims exactly one row only when its single dispatch slot is ready, processes it immediately, and
  repeats until work or budget is exhausted;
- leaves queued rows unleased with attempts unchanged and isolates a poison row from later dispatches;
- returns only `{ materialized, claimed, handled, ignored, retried, dead }`;
- makes no ordering guarantee.

- [ ] **Step 3: Add default-off scheduler jobs using dynamic imports.**

Near the existing outbox drain:

- every two minutes, job key `pathway-projector-shadow`;
- every five minutes, job key `pathway-projector-stale-lease-reaper`;
- `pathwayProjectorConfig.js` owns consumer/current-generation constants and an exact default-off flag
  resolver; `.env.example` documents the flag and `validateEnv.js` accepts only `true|false`;
- both jobs use the shared resolver and return before import unless it resolves true;
- use existing `registerCron` / `withJobLock`;
- do not add startup execution or an active mode.

Migration 578 seeds no registration. The first enabled tick registers generation 1. Once registered,
later disabling the flag pauses scheduler processing/reaping but neither retires the active row nor
disables trigger intake;
re-enabling drains the retained backlog.

- [ ] **Step 4: Add reliability gauges and unit coverage.**

Add:

- `pathway_projector_inbox_pending_rows`
- `pathway_projector_inbox_oldest_pending_age_seconds`
- `pathway_projector_inbox_leased_rows`
- `pathway_projector_inbox_dead_rows`
- `pathway_projector_inbox_retired_pending_rows`

Keep gauges label-free and avoid new eager imports. Bind every query to
`PATHWAY_PROJECTOR_CONSUMER_KEY` and `PATHWAY_PROJECTOR_GENERATION`, and use only the current generation
for pending/leased/dead/age gauges. `pathway_projector_inbox_retired_pending_rows` binds the canonical
consumer, joins offsets where `intake_retired_at IS NOT NULL`, and counts only their pending inbox rows
across retired generations. Retired-generation evidence remains directly queryable. Update the
read-replica-lag unit suite and real-Postgres reliability-metrics deep suite.

- [ ] **Step 5: Sweep scheduler mock consumers.**

At minimum rerun:

- `event-outbox-drain-deep.test.js`
- `notificationOutboxDrain.deep.test.js`
- `schedulerAdvisoryLock.deep.test.js`
- `unit/auditChainVerificationJob.test.js`

Dynamic imports should keep the new service outside the eager graph.

- [ ] **Step 6: Run replay, registry, metrics, and scheduler-targeted suites to GREEN.**
- [ ] **Step 7: Commit Task 5.**

Suggested commit: `feat(pathways): schedule configured observable shadow projector`

## Task 6: Webhook coexistence and complete exit evidence

**Files:**

- Modify `apps/backend/src/tests/event-outbox-drain-deep.test.js`.
- Complete both new deep suites.

- [ ] **Step 1: Add the coexistence regression.**

For a unique registered generation and event:

1. Register the generation, then insert the source event so its inbox row is trigger-coupled.
2. Assert the source retains the supplied `status`, `attempts`, `available_at`, `last_error`, and
   `delivered_at`; count matching `webhook_deliveries`.
3. Run claim/process.
4. Assert the source snapshot and delivery count are unchanged.
5. Run the existing webhook drain once.
6. Assert prior enqueue/delivery behavior and exact BIGINT bridge still pass.

- [ ] **Step 2: Complete the S1a matrix.**

Require explicit passing cases for:

- inverted commit order;
- no migration seed/default-off fanout;
- registration lock waits for pre-existing inserts and closes the trigger boundary;
- source/trigger commit and rollback atomicity;
- fixed-cutoff keyset cursor persistence/restart;
- cursor progress when a page materializes zero rows due to conflicts;
- explicit post-cursor low-id trigger capture;
- one live-intake generation per consumer;
- incomplete-backfill handoff rejection with no lifecycle mutation;
- fresh-higher handoff retirement/cutoff atomicity, pre-cutover replay, and sole-new post-cutover fanout;
- finite retired pending debt remains visible and does not block handoff;
- retired-generation reactivation rejection;
- an already-running old tick may claim/terminalize finite existing pending work after retirement; terminal CAS remains immutable;
- duplicate materialization;
- tenant-poison row cannot suppress the correct tenant;
- two-worker race;
- crash boundary;
- stale lease and stale-worker fencing;
- attempt-on-claim/no double-increment;
- dead-letter cap;
- tenant isolation/RLS;
- claim-on-dispatch leaves queued rows unleased/uncharged and honors the per-tick safety cap;
- source missing/mismatch fail-closed;
- BIGINT above safe integer;
- generation handoff/replay isolation, no retired future intake, and terminal CAS immutability (while an already-running old tick may finish finite existing pending work);
- relation/index/function collision preflight, definer search-path/operator guard, Dalekdefender and
  Prisma schema-`CREATE` denial, and migration/boot trigger-function execute revocation;
- six handled types vs every other dispatched event ignored;
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
  src/tests/unit/pathwayProjectorConfig.test.js `
  src/tests/unit/pathwayProjectorSchedulerWiring.test.js `
  src/tests/unit/prismaCoverage.test.js `
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

- no scalar live cursor/count shortcut; the only cursor is bounded by a fixed registration cutoff;
- no generation seed, event FK, or destructive delete/purge;
- registration lock, hardened `AFTER INSERT` trigger, and persistent backfill cursor are present;
- exactly one non-retired offset per consumer; trigger selects only it;
- incomplete-backfill handoff fails atomically; fresh-higher handoff retires old/registers new in one
  lock-fenced transaction; retired generations cannot reactivate;
- zero retired pending is an operational cutover recommendation, not a database liveness precondition;
- pre-existing named relations/indexes/functions fail closed on wrong owner, kind, or trigger-function shape before definer installation;
- the canonical runner records 578 and leaves its connection search path unchanged;
- the definer pins `pg_catalog, pg_temp`, uses schema-qualified application objects and a catalog-qualified operator guard;
- Dalekdefender and Prisma boot provisioning deny public-schema `CREATE` to their runtime/application roles, and Prisma boot role grants re-revoke trigger-function execution;
- trigger and projector do not mutate webhook-owned source fields;
- full tenant-inclusive inbox identity is used by PK/conflict/claim/reaper/CAS;
- no source outbox DML from S1a;
- exactly six generation-1 keys;
- no producer/domain/UI/API changes;
- all event ids remain strings at JS boundaries;
- `PATHWAY_PROJECTOR_SHADOW_ENABLED` defaults off;
- metrics bind the configured consumer/current generation and use the partial covering index;
- retired-generation pending debt has the consumer-scoped `pathway_projector_inbox_retired_pending_rows` gauge;
- git diff contains only the planned files.

- [ ] **Step 5: Open one PR and stop.**

PR title:

```text
Care Pathways S1a: lossless shadow event-consumer substrate
```

PR build ledger must include:

- base and head SHA;
- migration 578;
- exact registration/handoff/trigger/backfill boundary, schema/RLS/retention/link invariants;
- exact six handled event types and definition of handled;
- statement that all other dispatched events are ignored and delivery is unordered;
- exact commands and pass counts;
- scratch DB name and successful cleanup;
- webhook coexistence result;
- representative backlog/load evidence required before activation or concurrency tuning;
- planned handoff evidence (recommend zero pending), any retained residual debt, and retired-pending gauge result;
- migration catalog-preflight and deployment/boot privilege-hardening evidence;
- all deferred S1b/emitter/retention/D3–D7 work.

Push the branch, open the PR, wait for checks, and **STOP**. Do not merge or push more commits after the PR opens; hand any later fix to the coordinator.

## Self-review

- **Spec coverage:** registration/lifecycle/inbox/trigger/RLS/catalog preflight + Dalekdefender/boot privilege re-revocation → Task 2; immutable registry/six no-op observers → Task 1; registration/handoff boundary/fixed-cutoff backfill/BIGINT → Task 3; leases/CAS/retry/reaper/fail-closed join → Task 4; replay/config/default-off scheduler/current+retired metrics → Task 5; webhook/no-op/full evidence → Task 6; authoritative gates/delivery → Task 7.
- **No scope leakage:** no S1b runtime, projection, workflow, task, SLA, notification, emitter, UI, route, OpenAPI, infra beyond the single named runtime-role hardening file, retention purge, D3–D7, D8, or D9 implementation.
- **Correctness:** the table-lock boundary divides fixed-cutoff history from sole-generation trigger intake and atomically hands intake to fresh higher generations; delivery is complete but unordered; retired pending debt is explicit rather than mislabeled terminal; tenant identity is present throughout; attempts increment only on claim; terminal writes are owner/lease fenced; registry meaning is generation-scoped; event+tenant source relation fails closed.
- **Coexistence:** source outbox state and webhook delivery remain separately owned and regression-proven.
- **Operational safety:** true default-off before registration; disabling workers does not retire live intake; bounded backfill/claim caps, one dispatch slot, advisory locks, dynamic imports, current-generation telemetry plus retired-pending debt gauge, retained replay evidence, fail-closed catalog-object owner/kind/shape checks, definer search-path/operator hardening, deployment/boot privilege re-revocation, and activation/handoff load proof.
- **Governance:** D1 is adopted for S1a; D2 gates S1b; D8/D9 gate only named later integrations; none is silently inferred from this slice.
