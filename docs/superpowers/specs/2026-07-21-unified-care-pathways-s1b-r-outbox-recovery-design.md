# Unified Care Pathways S1b-r — Live Outbox Recovery Hardening Design

**Status:** implementation design; live-pipeline hardening with deployment held
**Grounding revision:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
(`2026-07-21T13:19:50+05:30`)
**Migration reservation:** `588_event_outbox_recovery_hardening.sql`
**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## 1. Outcome and safety boundary

S1b-r makes the existing live `event_outbox` to webhook pipeline recoverable without allowing a
crashed or stale worker, a partial fan-out, a duplicate replay, or an administrator from another tenant
to corrupt delivery state. It implements the program contract at
`2026-07-14-unified-care-pathways-program-design.md:493-495,854-856`: leased claims, stale-worker
fencing, stale-processing reaping, atomic idempotent subscription fan-out, webhook-delivery
uniqueness, and reasoned/audited dead-letter redrive. A bare `failed -> pending` reset remains
forbidden.

This is a live reliability and security correction, not a clinical pathway feature. It does not seed a
pathway, register a clinical handler, change any clinical clock, send a new class of notification,
alter Stroke/STEMI/cath authority, change OBGyn sequencing, or enable a tenant pathway mode. The
Pathway Projector remains an independent consumer of inserts through migration 578. Source outbox
redrive repairs webhook fan-out only; it must not manufacture a second projector inbox row or mutate a
projector outcome.

The code and migration may be reviewed and merged while deployment is held. Migration 588 is not
rolling-compatible with an old worker that still writes `status='processing'` or
`status='in_flight'` without a lease. Production activation therefore requires a later, explicit,
scheduler-quiesced non-rolling maintenance cutover. This design and its implementation plan do not
deploy, migrate a live database, enable a pathway, or notify an external party.

## 2. Verified baseline and defects

The following are repository facts at the grounding revision. File-and-symbol identity is normative;
line numbers are evidence anchors and may drift.

### 2.1 Source outbox lifecycle

- `event_outbox.id` is `BIGSERIAL`; the row has status, attempts, availability, error and delivery
  timestamps, but no status CHECK, lease owner or lease expiry
  (`migrations/009_future_proof_clinical_ai.sql:318-338`, `prisma/schema.prisma:5066-5085`).
- Migration 239 adds `tenant_id`, a tenant FK/index and FORCE RLS, but its policy is permissive when the
  tenant GUC is unset, empty or `bypass`
  (`migrations/239_tenant_rls_phi_phase_2c.sql:74-98,232-279`).
- `publishEvent({ tx })` is atomic with a caller transaction and rethrows; the historical no-transaction
  form is best-effort and returns `null` on failure (`eventOutboxService.js:34-119`).
- `claimPendingEvents` atomically selects due `pending` rows with `FOR UPDATE SKIP LOCKED` and changes
  them to `processing`, but records no owner, epoch or expiry (`eventOutboxService.js:142-187`). A
  process death after this commit leaves the row permanently ineligible.
- `markDelivered` updates by ID alone and accepts every current state (`eventOutboxService.js:190-198`).
  `markFailed` locks and updates by ID alone and can turn a delivered row back into pending while
  leaving contradictory historical fields (`eventOutboxService.js:221-255`). Neither operation is
  fenced to the claim that performed the work.
- The two-minute scheduler bridges each claimed row to webhook fan-out and then calls the blind source
  terminal method (`scheduler.js:393-460,594-605`).
- Reliability collection counts pending and terminal failed rows, not processing or stale-processing
  rows (`reliabilityMetrics.js:107-118`). A stranded claim is invisible to the current alert tier.

### 2.2 P0 — cross-tenant event-outbox administrator mutation

The admin surface exposes list, manual-delivered and manual-failed operations
(`routes/admin/eventOutboxRoutes.js:7-38`). It is protected by the parent ADMIN/SUPER_ADMIN route gate,
SUPER_ADMIN step-up, IP allowlist and rate limit (`app.js:1245-1251`), but that gate does not authorize
one tenant to mutate another tenant's event.

`POST /api/v1/admin/events/:id/failed` passes only the sequential outbox ID. `markFailed` opens a bare
interactive Prisma transaction whose inner SELECT and UPDATE contain no `tenant_id` predicate.
`prisma.js:428-432` explicitly documents that calls inside such a callback receive the raw transaction
client and are not auto-tenant-scoped. Because the RLS policy is permissive without a tenant GUC, a
tenant ADMIN who knows or guesses another tenant's ID can alter its delivery state. The same service
identity defect exists in the manual-delivered operation. Listing also lacks an explicit tenant
predicate and returns `patient_uid` plus the complete arbitrary payload.

This slice removes both blind state setters. Every remaining admin read or mutation receives the
server-derived tenant, uses `setTenantTx` for transactional work, and includes `tenant_id` in every
resource identity, lock and compare-and-set predicate. Cross-tenant and missing IDs are
indistinguishable to the caller.

### 2.3 P1 — partial, duplicate and falsely completed subscription fan-out

`enqueueDelivery` first reads matching subscriptions, then loops through them and performs one INSERT
per subscription. Each INSERT error is logged and swallowed, so a partial result resolves normally
(`webhookDeliveryService.js:102-165`). The source drain treats every resolved result, including
`webhook_subscriptions_unavailable`, `webhook_deliveries_unavailable`, or a partial `enqueued` array, as
success and marks the source delivered (`scheduler.js:410-454`). A matched subscription can therefore
lose its delivery permanently.

`webhook_deliveries.event_outbox_id` is a nullable BIGINT logical bridge with no FK, and its current
partial index is not unique (`migrations/347_widen_event_outbox_id_to_bigint.sql:3-18`,
`prisma/schema.prisma:11382-11408`). A retry after fan-out but before source completion can create a
second row with a different delivery ID. The downstream stable `X-VHHealth-Delivery-Id` protects only
retries of one delivery row; it cannot deduplicate two distinct rows created for the same source and
subscription (`webhookDeliveryService.js:305-318`).

S1b-r replaces the source bridge with one tenant transaction. It verifies the exact leased source,
performs a single set-based `INSERT ... SELECT ... ON CONFLICT DO NOTHING` for all eligible
subscriptions, and marks the source delivered in the same transaction. Any constraint, schema or
database failure rolls back both fan-out and source completion. A legitimate zero-match event may
complete; an unavailable schema or partial fan-out may not masquerade as zero matches.

Migration 588 adds a partial unique index on
`(tenant_id, event_outbox_id, subscription_id)` when both logical IDs are non-null. It first reports and
aborts on historical duplicate groups. It never silently deletes, merges or rewrites delivery evidence,
and it preserves the deliberate no-FK retention boundary.

### 2.4 P1 — webhook claim recovery and fencing

The webhook dispatcher atomically changes due `pending`/`failed` rows to `in_flight` and increments
`attempt_number`, but stores no owner or expiry (`webhookDeliveryService.js:172-238`). Its terminal
`markStatus` UPDATE is ID-only and swallows database errors (`webhookDeliveryService.js:428-460`). A
late worker can overwrite a newer attempt, and the caller can report success even when the terminal
write did not occur.

An existing five-minute stale reaper attempts to reset `in_flight` rows, but its SQL writes
`last_error`; `webhook_deliveries` has `error_message`, not `last_error`
(`webhookDeliveryService.js:398-425`, `prisma/schema.prisma:11382-11401`). The current unit test only
matches SQL text and therefore blesses the invalid column
(`tests/unit/webhookDeliveryService.test.js:348-368`).

Migration 588 and the dispatcher adopt the same lease model as the proven projector inbox:
`lease_owner` is a random UUID claim token, `attempt_number` is the claim epoch, and
`lease_expires_at` bounds ownership. Success, retry, dead-letter and reaping all compare tenant, ID,
expected state, owner token and epoch. A stale terminal write changes zero rows and cannot update
subscription counters or claim success.

Outbound HTTP remains at-least-once. If an endpoint accepts a POST and the worker dies before the
terminal database commit, the same stable delivery ID may be sent again. Consumers must continue to
deduplicate `X-VHHealth-Delivery-Id`; S1b-r prevents creation of a second ID for the same source and
subscription but does not claim impossible exactly-once behavior across an external network.

### 2.5 P1 — inactive gates and unsupported filters

Migration 115 states that an integration's status gates whether deliveries are sent
(`migrations/115_integration_webhook_registry.sql:15-18`). Current fan-out filters only by tenant,
event type and `webhook_subscriptions.is_active`; it never joins the parent integration
(`webhookDeliveryService.js:113-123`). Dispatcher claim and subscription lookup require neither the
current subscription active flag nor an active parent integration
(`webhookDeliveryService.js:195-227,246-260`). Consequently:

- paused, failed or archived integrations can receive newly enqueued work;
- queued work continues sending after an operator pauses the integration or subscription; and
- the automatic pause performed by `recordSubscriptionFailure` does not stop already-queued work
  (`webhookSubscriptionService.js:465-493`).

Both fan-out and dispatch now require a currently active subscription under a currently active parent
integration. Already-queued work is parked while either gate is inactive and becomes eligible again if
both are reactivated; it is not silently sent or silently discarded. Orphaned rows whose subscription
was deleted are deterministically marked dead without opening a network connection and are surfaced in
the existing dead-letter evidence.

The API also accepts and persists arbitrary non-empty `event_filter` objects, but fan-out never reads
them (`integrationRoutes.js:183-197,240-251`, `webhookSubscriptionService.js:235-299,394-396`). Sending
every matching event despite an operator-supplied filter can disclose more event payload than intended.
S1b-r does not invent a filter language. Creation, update and activation reject non-empty filters;
fan-out defensively requires `{}`; readiness and migration preflight fail on any active historical
non-empty filter. A future separately reviewed slice may define containment, expression or schema-aware
filter semantics.

### 2.6 P1 — redrive is absent or not governed

There is no event-outbox redrive route. The two existing event mutation endpoints neither require a
reason nor record the authenticated actor or prior state in durable audit evidence
(`eventOutboxRoutes.js:20-38`).

Webhook delivery has a redrive operation, but it accepts `dead`, `failed` and even `succeeded`, requires
no reason, mutates first, and then writes a best-effort `integration_logs` row
(`webhookDeliveryService.js:552-590`, `integrationRoutes.js:336-343`). Replaying a succeeded outbound
effect without an explicit governed reason is unsafe, and a log failure does not roll back the replay.

S1b-r adds two narrow dead-letter operations:

1. event source: tenant-bound `failed -> pending` only;
2. webhook delivery: tenant-bound `dead -> pending` only.

Each operation requires a bounded, non-empty operator reason and a server-derived authenticated actor.
Inside one tenant transaction it locks the eligible row, captures prior status/attempt/error evidence,
resets the retry-cycle fields, increments `redrive_count`, and inserts an append-only `audit_logs` row.
The audit row contains tenant, actor UID, actor role, resource ID, request ID, reason, prior state and
resulting state. Audit insertion failure rolls back the state transition. `audit_logs` already has a
database append-only guard (`migrations/324_audit_chain_hardening.sql:75-101`). Neither body actor fields
nor a best-effort log may authorize or prove a redrive.

The existing admin integration UI must stop offering webhook redrive for `succeeded` and retryable
`failed` rows and must collect a non-empty reason for `dead` rows
(`apps/admin/src/lib/api/integrationAdmin.ts:282-283`,
`apps/admin/src/app/(with-auth)/dashboard/integrations/page.tsx:628-635,719-729`).

## 3. Migration 588 contract

`588_event_outbox_recovery_hardening.sql` is one additive migration with these responsibilities:

1. Preflight `event_outbox` for unknown statuses, negative attempts and legacy contradictory terminal
   fields. Abort with counts and sample tenant/ID values; do not normalize unknown evidence silently.
2. Preflight `webhook_deliveries` for duplicate non-null
   `(tenant_id,event_outbox_id,subscription_id)` groups. Abort with actionable identities; do not delete
   attempts.
3. Preflight active webhook subscriptions with non-empty `event_filter`. Abort until an operator clears
   or deactivates each unsupported filter.
4. Add to `event_outbox`:
   - `lease_owner UUID`;
   - `lease_expires_at TIMESTAMPTZ(6)`;
   - `redrive_count INTEGER NOT NULL DEFAULT 0`;
   - status, nonnegative attempt/redrive, lease-pair and processing-state coherence CHECKs;
   - a partial stale-processing index on lease expiry and ID.
5. Add to `webhook_deliveries`:
   - `lease_owner UUID`;
   - `lease_expires_at TIMESTAMPTZ(6)`;
   - `redrive_count INTEGER NOT NULL DEFAULT 0`;
   - nonnegative attempt/redrive, lease-pair and in-flight-state coherence CHECKs;
   - a partial stale-in-flight index;
   - the partial unique source/subscription index.
6. During the scheduler-quiesced cutover, convert legacy unleased `processing` and `in_flight` rows into
   explicit retryable recovery work with a bounded error marker. Record affected counts in the migration
   provenance audit row.
7. Preserve tenant FKs/RLS, BIGINT logical bridge width, migration 578's `AFTER INSERT` trigger and the
   deliberate absence of a webhook-to-source FK.
8. Regenerate `prisma/schema.prisma` from the migrated schema and pass schema drift.

The lease coherence invariant is exact:

- source `processing` iff both lease fields are present; every other source state has neither;
- delivery `in_flight` iff both lease fields are present; every other delivery state has neither.

Attempts increment on claim. The attempt number returned with the lease is the fencing epoch. Failure
or lease expiry schedules the existing backoff and reaches terminal status at the existing seven-attempt
cap. Operator redrive resets the current retry-cycle attempt counter to zero, increments
`redrive_count`, and preserves the previous cycle in immutable audit metadata.

## 4. Runtime contract

### 4.1 Source claim, completion and reaping

`claimPendingEvents` accepts a generated UUID lease owner and bounded lease duration. Its single claim
statement selects due rows with `FOR UPDATE SKIP LOCKED`, changes them to `processing`, increments
`attempts`, sets the lease pair, and returns exact decimal-string IDs plus tenant, owner and attempt
epoch.

Every claimed-row operation normalizes and validates this immutable claim shape. Completion and failure
run through `setTenantTx` and include:

- `id` as BIGINT text;
- `tenant_id`;
- `status='processing'`;
- `lease_owner`;
- `attempts` equal to the claimed epoch.

An update affecting zero rows is a lost fence, not success. It must not be converted into delivered or
failed, increment a misleading result counter, or expose another tenant's row.

The stale source reaper is bounded, uses `FOR UPDATE SKIP LOCKED`, and selects only expired processing
leases. It clears the lease, schedules the existing backoff, and either returns the row to pending or
dead-letters it at the cap. Its UPDATE repeats tenant, ID, owner and epoch from the locked stale set.

### 4.2 Atomic source-to-delivery fan-out

The source drain no longer calls the ad-hoc loop and then marks delivered separately. For each claim it
executes one tenant transaction that:

1. locks and revalidates the exact claim fence;
2. selects subscriptions matching the source tenant and event type;
3. requires `subscription.is_active=true`, parent `integration.status='active'`, and
   `event_filter='{}'::jsonb`;
4. inserts all delivery intents with a set-based statement and
   `ON CONFLICT (tenant_id,event_outbox_id,subscription_id) ... DO NOTHING` under the partial uniqueness
   predicate;
5. verifies that every eligible subscription is represented by either an existing or newly inserted
   row; and
6. CAS-marks the source delivered and clears its lease before committing.

If any step fails, zero new delivery rows and zero source-terminal changes commit. Re-executing after an
ambiguous commit is safe: existing unique rows satisfy coverage, missing rows are inserted, and the
source fence decides whether completion is still legal.

The ad-hoc admin enqueue surface must not accept an arbitrary `event_outbox_id`. A manual test delivery
may use a null logical bridge and must be independently reasoned/audited; only the internal leased source
operation may create a source-linked delivery.

### 4.3 Webhook dispatch, parking and terminal CAS

Webhook claim generates a UUID lease, increments `attempt_number`, stamps expiry and returns the
fencing shape. Eligibility requires the current subscription and parent integration to be active.
Inactive work remains pending or retryable-failed with its existing due time and is counted as parked.
Reactivation makes it eligible without rewriting delivery history.

After the outbound attempt, terminal/retry mutation requires the exact tenant, delivery ID,
`status='in_flight'`, owner and attempt epoch. Subscription success/failure counters are applied only
after that fence succeeds. The repaired reaper writes `error_message`, not `last_error`, and uses the
same owner/epoch fence. Deleted-subscription orphans are made terminal without a fetch.

## 5. Administrative API and audit contract

The final event-outbox surface is:

- `GET /api/v1/admin/events` — explicit `tenant_id` filter, validated status/pagination, PHI access
  evidence, decimal-string IDs;
- `POST /api/v1/admin/events/:id/redrive` — failed-only, reason required, actor server-derived.

The manual `/:id/delivered` and `/:id/failed` routes are removed rather than renamed. No repository
client consumes them at the grounding revision. Unknown list status returns 400 instead of silently
becoming `pending`.

The webhook delivery surface retains list/detail, dispatch and governed mark-dead operations, but:

- mark-dead requires a reason;
- redrive accepts only `dead` and requires a reason;
- succeeded and retryable-failed rows are not redriveable;
- both operations are tenant-qualified and atomically audited; and
- actor UID/role/request ID come from authenticated request context, never request body.

Parent route protection remains ADMIN/SUPER_ADMIN plus existing SUPER_ADMIN step-up, IP allowlist and
rate limit. This is necessary but not sufficient: service-layer tenant equality and state CAS remain
mandatory.

## 6. BIGINT and projector coexistence

`event_outbox.id` and `webhook_deliveries.event_outbox_id` remain BIGINT. Every JavaScript boundary uses
the exact decimal string; `Number`, `parseInt` and unsafe JSON-number coercion are forbidden for source
IDs. Existing tests already prove `9007199254740995` round-trips through the bridge
(`tests/event-outbox-drain-deep.test.js:405-426`); S1b-r extends that proof through leases, audit and
redrive.

Migration 578's projector trigger fires only on INSERT. A source redrive is an UPDATE and deliberately
does not retrigger projector intake. If a projector inbox row is itself dead, S1b-c recovery tooling
owns its separate governed replay. S1b-r neither deletes nor rewrites `event_consumer_offsets` or
`pathway_projector_inbox`.

## 7. Observability and scheduler contract

Add DB-derived gauges for source processing, source stale-processing, webhook in-flight, webhook
stale-in-flight and webhook parked rows. Add bounded counters for source lease reaps, webhook lease
reaps and operator redrives. Existing pending/dead-letter metrics remain.

Register source and webhook stale-lease reapers under distinct `withJobLock` names. Preserve the current
two-minute source drain and 30-second webhook dispatch schedules; no clinical time is encoded here.
Update `backend-reliability-alerts.yaml`, the reliability dashboard and `RUNBOOK_ONCALL.md` so a stale
lease or repeated reaping is actionable rather than invisible.

## 8. Rollout and rollback

### 8.1 Merge-time posture

- no live deployment;
- no live migration;
- no pathway-mode flip;
- no external webhook smoke against a real recipient;
- all code paths remain compatible with pathway modes being off.

### 8.2 Future non-rolling cutover

Before migration 588 is applied to any live environment:

1. inventory invalid source states, duplicate delivery tuples, active non-empty filters, unleased
   processing/in-flight rows and parked work;
2. stop every source drain, webhook dispatcher and stale reaper across the fleet;
3. apply migration 588 through one controlled migration runner;
4. start only the new code version;
5. verify lease constraints, uniqueness, gauges, reaper dry-run and tenant-bound admin reads;
6. perform an internal sink-only canary with a deduplicating endpoint; and
7. resume scheduled delivery only after the evidence is clean.

Because old code cannot satisfy the new lease-state CHECKs, rolling back to the old worker after the
migration is not safe. Rollback is traffic/scheduler hold plus forward fix or restoration of the
pre-cutover database snapshot under the approved recovery runbook. Additive lease columns may remain,
but the old unfenced worker must never be restarted against the hardened constraints.

## 9. Explicit non-goals

- notification-outbox redesign;
- projector-inbox redrive or generation handoff;
- defining non-empty webhook filter semantics;
- exactly-once external HTTP delivery;
- changing event payload contracts or retention;
- changing clinical pathway definitions, clocks, owners, tasks, SLAs or patient visibility;
- tenant activation, backfill or deployment;
- Forgejo synchronization or any external notification.

## 10. Verification contract

Real PostgreSQL tests must prove:

1. two concurrent source claims are disjoint and carry owner/expiry/epoch fences;
2. an unexpired lease cannot be reaped;
3. an expired lease retries, and the seventh claimed failure/expiry dead-letters once;
4. a late source worker cannot complete or fail after reaping and reclaim;
5. source completion creates exactly one delivery for every eligible subscription and commits the source
   transition atomically;
6. an injected fan-out error commits neither deliveries nor source completion;
7. replay/concurrency preserves one `(tenant,event,subscription)` row;
8. inactive subscriptions/integrations receive no new fan-out and no outbound fetch, while reactivation
   releases parked work according to the stated policy;
9. active non-empty filters fail closed;
10. the webhook reaper executes against the real `error_message` column;
11. a late webhook worker cannot overwrite a newer attempt;
12. source and webhook redrive require the correct tenant, terminal state, authenticated actor and
    non-empty reason;
13. concurrent redrive allows exactly one CAS winner;
14. audit insertion failure rolls back redrive;
15. BIGINT IDs remain exact through claim, fan-out, list, audit and redrive;
16. projector inbox/source evidence is unchanged by source redrive; and
17. invalid state, lease and duplicate tuples are rejected by migration 588 constraints/indexes.

Route/unit tests additionally prove inherited RBAC, generic cross-tenant not-found behavior,
server-derived actor provenance, invalid-status 400s, OpenAPI request/response shapes, admin reason UI,
scheduler wiring and metric serialization. No assertion may accept `[200,500]`, a partial enqueue, a
best-effort audit, or both pending and failed when one exact state is required.

## 11. Exit condition

S1b-r is complete only when migration 588 and Prisma agree; blind event state setters are absent;
tenant-bound leased source claims and leased webhook attempts are fenced and reapable; source fan-out is
atomic and unique; active gates and fail-closed filters are enforced; both dead-letter redrives are
reasoned and atomically audited; BIGINT and projector-independence conformance stays green; observability
and runbooks cover stale work; the focused and full backend/admin gates pass; and no deployment,
pathway activation, live migration or external notification has occurred.
