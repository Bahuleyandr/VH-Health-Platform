# C6.1 external-recovery operability — design delta

**Status:** Step 1 design delta and Step-0 preflight only; build queued<br>
**Branch:** `feat/continuity-recovery-operability`<br>
**Live baseline re-fetched:** `github/main` at
`10c4a3a66a32d2aa5bf23041d2de3737e59365bd` on 2026-08-05<br>
**Activation state:** inert; no offset, family, partition, worker, alert delivery,
deployment, or production authority changes in this commit<br>
**Merge state:** never merge from this lane

## 0. Step-0 coordinator preflight

### 0.1 Verdict

Preflight was refreshed at `2026-08-05T05:23:38+05:30` after fetching
`github/main`.

| Check | Live result | Step-1 ruling |
|---|---|---|
| Base | `github/main` is `10c4a3a66a32d2aa5bf23041d2de3737e59365bd` | The branch was fast-forwarded to this exact SHA; design authority only |
| Committed migration ceiling | `624_clinical_continuity_held_message_release.sql` | DDL is required in Step 2, but no migration number is reserved |
| Held-release precedent | PR #733 merge `c02c5bb34d9217cd0513219b8080430a81b3d85e` is an ancestor of the baseline | Reuse its exact-item, server-derived, idempotent receipt, workbench, audit, RLS, and raw-PostgreSQL doctrine |
| Facility-label precedent | PR #708 merge `4c2d6abd3c47dc5c37614ccd91cf5dde4447174a` is an ancestor of the baseline | Preserve tenant/facility identity in every external-recovery alert series; never aggregate a sick facility behind a healthy peer |
| Output-observation precedent | PR #736 merge `d07d72f68fd6b19b77c5fd91c9782b6576d9ba2f` is an ancestor of the baseline | Alert on database output, publish real zeros, and separately alarm when the output observation is absent or stale |
| Activation-doc refresh | PR #742 merge `10c4a3a66a32d2aa5bf23041d2de3737e59365bd` is the baseline | Its refreshed tracker independently records all three Packet-BV gaps as open questions; this delta closes their design, not their activation |
| Migration owner #737 | Open PR #737 owns `625_hl7_outbound_contiguity_ledger_version.sql` and Prisma | Step 2 waits; it does not call itself 625 or resolve Prisma before #737 lands |
| Device-loss owner | Draft PR #741 currently adds only `c4-device-loss-orchestration-design-delta.md`; its cleared build is ordered after #737 | This delta is parallel-safe, but this lane's Step 2 queues behind both #737 and the device-loss build and derives a fresh migration afterward |
| Other open PRs | #739 changes pinned continuity policy/runtime files; #740 changes cath/cold-chain deep-test teardown only | No Step-1 collision. Step 2 must re-fetch and re-inventory; #739 is semantically relevant to policy evidence even though this design does not edit its files |
| Step-1 ledger | This document only | No runtime, migration, generated artifact, alert rule, application, or activation file is edited |
| Build readiness | The three defects and all three named precedents are present on the live baseline; the serialized migration owners are not cleared | **WAIT — commit the delta, then stop** |

DDL is required because Step 2 needs immutable operator-action evidence and an
append-only late-critical awareness obligation/acknowledgement binding. The
builder must re-fetch `github/main`, prove #737 and the device-loss build are
landed or explicitly cleared, inspect all committed and open migrations, and
choose `max(committed and queued migration number) + 1`. This document does not
predict or reserve that number.

### 0.2 Verified defects

All three audit findings reproduce in current code.

1. **The recovery cursor has no authenticated operator surface.**
   `registerExternalRecoveryOffset()` inserts directly into
   `event_consumer_offsets`
   (`apps/backend/src/services/integrations/externalInterfaceRecoveryService.js:160`),
   and `authorizeExternalRecoveryResume()` performs the only
   `paused -> replaying` transition (same file at line 286). Outside tests,
   their only production references are their definitions/exports and the I10
   aliases at lines 836-851; no controller or route imports them. Migration
   603 applies forced RLS to the table at
   `apps/backend/src/migrations/603_external_interface_recovery.sql:152-180`
   but retains column-scoped runtime `INSERT`/`UPDATE` authority at lines
   847-885. With no authenticated route or immutable operator receipt, a real
   activation therefore falls back to migration-owner/manual SQL against that
   live table rather than an owner-audited command.
   The refreshed activation tracker records the same open question at
   `docs/continuity/activation-readiness-tracker.md:110`.
2. **C6.1 output is operationally silent.** `reliabilityMetrics.js` measures
   the pathway projector's global inbox at
   `apps/backend/src/observability/reliabilityMetrics.js:34-38`, but its gauge
   inventory has no external-interface offset state, external pending/dead
   depth, oldest pending age, or late-critical awareness. The production rule
   files have no corresponding alert. The refreshed activation tracker records
   the same observability gap at
   `docs/continuity/activation-readiness-tracker.md:164`.
3. **Late critical laboratory awareness is not closed.**
   `externalLabRecoveryService.js` correctly creates a critical-priority
   `DUTY_DOCTOR` review task with `slaCompletionSemantics: 'none'` and no due
   time (`apps/backend/src/services/integrations/externalLabRecoveryService.js:575-580`).
   Migration 608 proves exactly that no-SLA task and rejects any
   `lab_critical_alerts` or `workflow_sla_instances` effect at
   `apps/backend/src/migrations/608_external_lab_recovery.sql:202-289`. The
   generic escalation engine's `sla_breach` arm joins
   `workflow_sla_instances`
   (`apps/backend/src/services/workflow/escalationEngineService.js:792-815`),
   so the recovered task cannot enter the live critical-result escalation
   path. The Staff clinical inbox polls at least every two minutes and its main
   rail badges pending work
   (`apps/staff/lib/core/providers/clinical_inbox_provider.dart:8-47` and
   `apps/staff/lib/core/widgets/main_scaffold.dart:131-166`), but there is no
   durable recovery-specific acknowledgement obligation and no page if it
   remains unseen. The countersigned required destination is the existing
   critical-results inbox (`docs/continuity/c0-4-owner-decision-dossier.md:177-188`),
   while the refreshed tracker records the missing completable channel at
   `docs/continuity/activation-readiness-tracker.md:130`.

### 0.3 Frozen Step-1 ledger

Step 1 adds only:

- `docs/continuity/c6-1-external-recovery-operability-design-delta.md`.

There is no migration, Prisma regeneration, backend or frontend source change,
generated OpenAPI change, metric, alert, test execution against a migrated
database, family activation, push, merge, or deployment in Step 1.

## 1. Outcome and binding authority

Step 2 will close the three pre-activation blockers with one linked operability
slice:

1. an Admin-authenticated workbench and two exact-partition commands for offset
   registration and resume authorization;
2. complete, facility-preserving database-output metrics and Prometheus rules
   for offset, inbox, and awareness states; and
3. the **existing critical-results inbox** as the human channel for a late
   critical laboratory result, backed by an append-only continuity-awareness
   obligation, an acknowledgement receipt, and an operational page until one
   authorized human acknowledges it.

The third ruling is not a new product choice. Countersigned C-D8 says that a
late critical lab result appears in the critical-results inbox for human
acknowledgement, is never silently dropped, and is never auto-alerted as a
fresh breach. This delta makes that selected channel reliable. A dedicated
review application would duplicate the already mounted, role-scoped, polling,
realtime-refreshed, rail-badged inbox and create two places clinicians must
watch.

The slice does not make an interface eligible merely because code exists. It
adds a command boundary that an authorized Admin may later use for one exact
tenant/family/direction/partition/generation. Deployment, a global family
toggle, worker start, source enrollment, credentials, signed owner evidence,
and the actual command invocation remain separate gates.

## 2. One surface, not a second recovery engine

### 2.1 Admin workbench ruling

The operator presentation extends the existing Admin **Continuity
Reconciliation** page with an `External recovery` tab. It copies the held-
release workbench shape: exact source identity, safe evidence, server-derived
classification, capability booleans, typed refusal reasons, immutable prior
outcome, and no raw payload/ciphertext/credential material.

The HTTP surface is an Admin control plane under `/api/v1/admin`, not the C5.2
paper-reconciliation router. The latter is deliberately gated by the paper-
reconciliation feature and a Staff continuity facility-context envelope; an
external tenant-scoped recovery offset must not become unavailable merely
because that unrelated C5.2 runtime gate is closed. The `/api/v1/admin` mount
already applies authenticated `ADMIN_ROUTE_ROLES`, SUPER_ADMIN MFA step-up,
the Admin IP allowlist, and Admin rate limiting. The new router reasserts the
closed `ADMIN`/`SUPER_ADMIN` role set so technical or clinical Staff visibility
cannot become offset authority.

Frontend visibility is never authorization. Every act reloads the current
actor, tenant, offset, catalog entry, and policy evidence inside the effect
transaction.

### 2.2 Exact item and server-derived command classes

There is no predicate or family-bulk action. A command identifies one exact
source tuple:

`tenant + interface family + resolved direction + source partition + generation`

and, for resume, one exact `offset_id` and current state fingerprint.

The server resolves the catalog entry and derives all of the following:

- whether the family/subpath is implemented and `hwm_required`;
- `facility_scope`, required/forbidden `facility_id`, direction, cursor kind,
  partition kind, and consumer key;
- the command class: `register_paused_offset`,
  `register_marker_absent_offset`, or `authorize_partition_resume`;
- the only legal prior and next recovery states; and
- the canonical effect identity and command fingerprint.

The client cannot submit `scope_kind`, `facility_scope`, `cursor_kind`,
`consumer_key`, `recovery_state`, actor identity, role, command class, outcome,
next state, timestamps, or audit IDs. I05 may select one catalog-supported
protocol and `inbound`/`outbound` direction, and a mixed family must select one
catalog subpath; the server still derives the resulting class and refuses an
unsupported combination. Unknown, unimplemented, `not_applicable`, or
unselected mixed dispositions fail closed.

### 2.3 What the commands do

- **Register one offset** calls the hardened registration core after all
  authority and evidence checks. A complete initial marker produces `paused`.
  An absent marker produces
  `reconciliation_required_missing_marker`; it never silently starts at zero
  or at the source's current tail.
- **Authorize one resume** compare-and-swaps one exact `paused` offset with a
  complete high-water marker to `replaying` and pins one exact cutoff marker.
  It does not start a process, dispatch an item, advance a cursor, or authorize
  another partition.

The existing `registerExternalRecoveryOffset()` and
`authorizeExternalRecoveryResume()` remain the canonical state-changing cores;
the new service wraps and hardens them rather than adding another cursor,
inbox, replay ledger, or state machine.

## 3. Endpoint and OpenAPI contract

### 3.1 Exact endpoint set

| Purpose | Method and path | Contract |
|---|---|---|
| Workbench | `GET /api/v1/admin/continuity/external-recovery/workbench` | Lists current-tenant live offsets, exact partitions, server-derived classes/capabilities, safe marker/state evidence, pending/dead counts and age, critical-awareness counts, and immutable command outcomes; optional family/state filters are read-only |
| Register one partition | `POST /api/v1/admin/continuity/external-recovery/offsets` | Requires `Idempotency-Key`; accepts one exact family/subpath/protocol/direction selection, partition, generation, catalog-permitted facility, marker/retained-range evidence, signed retention evidence, and typed reason; returns applied or exact-duplicate receipt |
| Authorize one partition | `POST /api/v1/admin/continuity/external-recovery/offsets/{offsetId}/resume-authorizations` | Requires `Idempotency-Key`; accepts the expected state fingerprint, exact cutoff marker, signed owner-evidence reference, and typed reason; returns applied or exact-duplicate receipt |

The workbench may filter its read. Neither POST accepts a list, wildcard,
family predicate, state predicate, age predicate, SQL fragment, `apply_all`, or
`start_at_current` option.

Registration accepts only these typed reason codes:

- `initial_marker_reconciled`;
- `retained_range_verified`; and
- `marker_absence_recorded`.

Resume authorization accepts only:

- `resume_cutoff_reconciled`;
- `source_count_reconciled`; and
- `owner_recovery_evidence_reconciled`.

Each reason requires normalized, non-control-character detail of 10-500
characters. There is no client-defined reason code or free-form-only path.

### 3.2 Operation-overlay descriptions

The generated operation descriptions must carry the safety boundary in the
contract itself:

- **Workbench:** “Returns current-tenant external-recovery partition state,
  server-derived command capabilities, safe marker evidence, command receipts,
  and output observations. Visibility does not grant offset authority and no
  source payload, ciphertext, secret, or credential is returned.”
- **Register:** “Registers one exact implemented HWM partition as paused or
  marker-missing and atomically appends operator/audit evidence. It performs no
  family activation, worker start, replay, dispatch, cursor advance, clinical
  effect, or notification.”
- **Authorize resume:** “Authorizes replay only for the exact paused offset,
  generation, state fingerprint, and cutoff marker and atomically appends
  operator/audit evidence. It performs no worker start, item claim, cursor
  advance, retrospective alert, pathway, SLA, or notification effect.”
- **Clinical-inbox acknowledge overlay:** “For a C-D8 late-critical recovery
  task, appends the exact continuity-awareness acknowledgement while keeping
  the task no-SLA and pending clinical review. It does not create or complete a
  critical-result SLA and does not fire a lab alert, pathway transition, or
  notification.”

The new Admin operations extend the existing clinical-continuity OpenAPI
schema domain, and the clinical-inbox operation description extends
`clinicalInbox.mjs`. There is no handwritten spec patch after generation.
**`apps/backend/src/docs/openapi.json` and
`packages/vhhealth_core/swagger/openapi.json` move in the same commit and are
proved byte-identical.** Stock Spectral, live-route parity, baseline, and real-
description assertions are mandatory.

## 4. Command identity, idempotency, and atomic evidence

### 4.1 Stable effect identities

The registration effect identity binds:

- tenant, catalog-resolved facility scope/facility, family, direction,
  partition, and generation;
- the server-fixed registration action/binding/schema versions; and
- the canonical initial/retained marker and signed policy-evidence identities.

The resume effect identity binds:

- tenant and exact offset ID;
- the offset's family, direction, partition, generation, and facility scope;
- the exact prior state fingerprint and cutoff marker; and
- the server-fixed resume action/binding/schema versions.

The command fingerprint additionally binds actor UID/current normalized role,
typed reason/detail, request route/method, policy/owner evidence, exact
prior-state object and hash, and the only permitted next-state object and hash.
Request ID, response timing, retry count, and later worker/cursor state are not
part of the effect identity.

`Idempotency-Key` is an auxiliary request identity, not permission to create a
second effect. After current authorization is rechecked:

- the same effect identity and fingerprint returns the immutable prior receipt
  without another offset, action, audit, or state change;
- the same idempotency key or effect identity with different actor, marker,
  policy, reason, state, family, partition, or cutoff is typed drift and fails
  closed;
- concurrent exact requests converge on one applied receipt; and
- a lost response is recoverable only by the same currently authorized actor
  with the exact fingerprint.

### 4.2 One atomic command transaction

The registration lock/effect order is tenant and facility evidence, catalog and
signed policy evidence, live tuple/advisory key, offset tuple, operator action,
and clinical audit. The resume order is tenant and facility evidence, current
actor, offset row, matching prior operator receipt/evidence, operator action,
and clinical audit.

Within one serializable tenant transaction the service:

1. reloads current actor/role and validates the exact closed request shape;
2. resolves the server catalog class and verifies signed owner/retention
   evidence;
3. locks the exact tuple/offset and recomputes the state and command hashes;
4. claims the immutable effect identity;
5. performs the one registration insert or one exact state compare-and-swap;
6. appends the applied operator-action row with exact prior/next evidence;
7. appends one structured clinical-continuity audit event; and
8. returns the receipt only after all evidence is durable.

The database enforcement copies migration 624 rather than trusting the route.
Two narrow `SECURITY DEFINER` command functions own action insertion and the
exact registration or `paused -> replaying` transition. An owner-only insert
guard makes the action table unforgeable. Offset transition guards require the
exact action/effect/fingerprint claimed in the current transaction and recheck
its typed tenant, facility scope, family, direction, partition, generation,
offset, actor, prior state, marker, and only legal next state. Setting the
function's transaction-local marker without the matching immutable action row
cannot satisfy the guard.

Migration 603's worker-required cursor columns are not globally revoked. The
guards isolate only initial external-offset registration and resume authority;
existing replay claims, source-gap/retention-gap/provider-state transitions,
ordered high-water advancement, and `replaying -> ready` keep their current
semantics and authorities. The exported JavaScript registration/resume
functions remain the canonical application cores but call the dedicated
database commands instead of issuing their current direct `INSERT`/`UPDATE`.

All eight operations commit or roll back together. Known authenticated
refusals are appended after the failed effect transaction in a separate,
tenant-scoped attempt transaction, following the held-release pattern. An
authentication failure with no trusted tenant/actor context is logged by the
existing security/audit boundary and cannot create a caller-selected tenant
row.

There is no post-commit worker call, source connector call, queue insertion,
cursor advance, domain adapter call, notification, SLA action, or pathway
transition.

## 5. Append-only data shape

### 5.1 `external_recovery_operability_actions`

One immutable table carries applied receipts and authenticated refusal
evidence. Typed columns include:

- action UUID, tenant, optional catalog-required facility, family, direction,
  partition, generation, and optional offset ID;
- `register_offset` or `authorize_resume` action and server-derived command
  class;
- bounded outcome such as `applied`, `refused_stale`, `refused_drift`,
  `refused_policy`, `refused_scope`, or `infrastructure_failure`;
- effect identity, command fingerprint, hashed raw idempotency identity,
  request ID, HTTP method/path, and action/binding/schema versions;
- actor UID, normalized role, typed reason/detail, and owner/policy evidence;
- exact typed marker fields plus canonical prior/next state objects and their
  SHA-256 hashes;
- linked clinical audit event for applied outcomes; and
- recorded time and inherited signed retention-policy identity/cutoff.

JSON is corroborating evidence, never sole authority. Family, direction,
partition, generation, marker, actor, reason, outcome, and hashes are typed.
A partial unique applied-effect index prevents a second registration/resume
effect. Exact duplicates return the existing applied row and do not append a
second “duplicate” fact.

For an applied registration, the server allocates the offset ID before the
command and the action and offset bind each other through same-tenant,
deferrable exact keys. For resume, the existing offset binds the exact applied
authorization action. The binding columns are immutable; neither a JSON
receipt nor a transaction-local setting can stand in for the relational proof.

### 5.2 `external_recovery_critical_review_obligations`

Migration 608's exact no-SLA task remains the clinical work item. The new
immutable obligation binds one late-critical awareness duty to:

- tenant, honest facility scope/facility identity, I01/I02 family, recovery
  inbox, offset, and exact task;
- patient UID and the exact sorted critical result IDs;
- source occurrence time and recovery-recorded time kept distinct;
- the server-derived `DUTY_DOCTOR` recipient class;
- `late_pending_only` and a fixed obligation contract version; and
- inherited signed retention evidence.

There is exactly one obligation per recovery inbox/task. It has no `due_at`,
breach time, escalation tier, lab-alert ID, workflow-SLA ID, pathway ID, or
notification ID. Open versus acknowledged is derived from the existence of an
exact acknowledgement row, not from updating the obligation.

### 5.3 `external_recovery_critical_review_acknowledgements`

One immutable row binds the obligation and task to the authorized actor,
current role/assignment authorization mode, task acknowledgement timestamp,
request ID, and canonical receipt hash. A unique obligation key permits one
awareness acknowledgement. It does not resolve the review task or certify a
clinical interpretation; it proves that the required human channel was seen.

The existing `/api/v1/clinical-inbox/tasks/{id}/acknowledge` route remains the
single Staff action. For a matching late-critical obligation it runs the
ordinary assignment/role/break-glass authority check, changes the task from
`open|overdue` to `in_progress`, and appends the acknowledgement in the same
transaction. Exact repeats return the same task/receipt. Noncritical late-
recovery tasks continue through the current generic acknowledgement path.

## 6. Human-reachable late-critical channel

### 6.1 Selected mechanism

The mechanism is named **C-D8 late-critical continuity awareness** and is
presented in the existing Staff **Critical results / Clinical inbox**.

The guarantee has three independent layers:

1. the recovery transaction cannot complete without the current critical-
   priority `DUTY_DOCTOR` task and exact immutable awareness obligation;
2. the Staff provider refreshes from realtime lab/clinical-alert events and at
   least every two minutes, while the open inbox screen refreshes each minute
   and the main rail badges every task that needs clinical action; and
3. the Prometheus rule
   `ExternalRecoveryCriticalReviewUnacknowledged` pages the continuity on-call
   whenever an obligation has no acknowledgement receipt. It clears only when
   the receipt exists, not when a worker or HTTP request merely succeeds.

The page reuses C1.3's existing critical routing tree: operations webhook,
critical PagerDuty receiver, and the `team: continuity` receiver, all with
resolved delivery. It creates no parallel receiver or credential. Human reach
is not claimed from rule code alone: activation remains refused until the C1.3
live drill proves the source series, evaluated rule, receiver deliveries,
external Watchdog, and a named operator acknowledgement as specified in
`docs/runbooks/C1_3_MONITORING_LIVE_DRILL.md:135-169`. Alertmanager repeats the
open page until the database acknowledgement output clears it.

The page annotation says “Late critical result awaits continuity awareness —
open the facility/tenant critical-results inbox.” It never says a fresh lab
threshold fired, a clinical SLA breached, or the patient was newly unstable.
It is an operational page about a missing human acknowledgement of recovered
work, evaluated from recovery-recorded time, not a retrospective clinical
alarm evaluated from source occurrence time.

### 6.2 C-D8 non-effect proof

The current database effect guard remains unchanged. A late-critical recovery
still has:

- no `lab_critical_alerts` row;
- no `workflow_sla_instances` row and
  `tasks.sla_completion_semantics = 'none'`;
- no `care_pathway_transition_events` row;
- no `notification_outbox` row;
- no patient notification or realtime “fresh critical alert” event; and
- no mutation of the source occurrence time into “now.”

The obligation and operational metric are expressly permitted evidence of
human awareness. They are not admitted to any of the three migration-603
effect tables, do not call `enqueueCriticalResultTask()`, and are not candidates
for `escalationEngineService`'s `critical_result_ack` SLA rules. Migration 608's
deferred exact-task/no-alert/no-SLA checks are extended to require the
obligation and remain otherwise intact.

## 7. Metrics and alert rules

### 7.1 Complete database-output snapshot

The long-running backend's existing reliability collection cadence performs
one complete read of live external offsets, external inbox rows, and open
critical-awareness obligations. A successful observation atomically replaces
the prior label snapshot; a failed or malformed query publishes no fabricated
zeros and does not partially mix snapshots.

The series are:

| Metric | Meaning |
|---|---|
| `external_recovery_active_offsets` | Live external offsets in the exact current `recovery_state` |
| `external_recovery_inbox_pending_rows` | External-interface inbox rows still `pending` |
| `external_recovery_inbox_oldest_pending_age_seconds` | Age since `recorded_at` of the oldest pending row; zero when none |
| `external_recovery_inbox_dead_rows` | External-interface inbox rows in terminal `dead` |
| `external_recovery_critical_review_unacknowledged_rows` | Late-critical obligations with no acknowledgement receipt |
| `external_recovery_critical_review_oldest_unacknowledged_age_seconds` | Age since obligation creation of the oldest unacknowledged row; zero when none |
| `external_recovery_observation_timestamp_seconds` | Time of the last complete valid database-output observation |
| `external_recovery_offsets_observed_total` | Total live external offsets; always emitted, including zero |

Every per-scope series carries bounded labels
`tenant_id`, `facility_scope`, `facility_id`, `interface_family`, and
`direction`; the offset gauge also carries `recovery_state`. `source_partition`,
offset/inbox/task/result IDs, patient identity, reason text, and payload fields
are deliberately not Prometheus labels. Workbench and bounded logs provide the
exact partition/item drill-down.

For a facility-scoped catalog entry, `facility_id` is the real facility ID. A
tenant-scoped entry uses the explicit literal `tenant-wide`, carries
`facility_scope="tenant"`, and retains `tenant_id`; it is never attributed to a
fabricated facility and never aggregated with another tenant. This is the #708
rule applied honestly to C6.1's mixed tenant/facility model.

The collector emits pending/dead/age/awareness zeros for every observed live
offset scope. A deployment with no live offsets still emits total `0` and a
fresh observation timestamp. A deployment that cannot observe emits no fresh
timestamp, so silence cannot become green.

### 7.2 Exact rules

The rules extend `backend-reliability-alerts.yaml`, retain the label set with
`max by (...)` across identical backend pods, and route to `team: continuity`:

| Alert | Expression/hold | Severity and meaning |
|---|---|---|
| `ExternalRecoveryObservabilityUnobserved` | observation timestamp absent, or `time() - max(timestamp) > 300`; `for: 5m` | critical; the output is unknown, never assumed healthy |
| `ExternalRecoveryOffsetRequiresReconciliation` | state-labelled offset count `> 0` for `recovery_state=~"reconciliation_required_.*"`; `for: 0m` | critical; names tenant/facility scope, family, direction, and exact state |
| `ExternalRecoveryInboxDeadRows` | dead rows `> 0`; `for: 0m` | critical; terminal recovery work exists |
| `ExternalRecoveryInboxPendingStalled` | pending rows `> 0` and oldest pending age `> 900`; `for: 5m` | critical; backlog has remained unhandled for at least 15 minutes after recovery recording |
| `ExternalRecoveryInboxBacklogHigh` | pending rows `> 500`; `for: 15m` | warning; capacity signal, not permission to bulk replay |
| `ExternalRecoveryCriticalReviewUnacknowledged` | unacknowledged late-critical obligations `> 0`; `for: 0m` | critical continuity-awareness page; not a fresh clinical alarm or SLA breach |

The rules assert rows/states/ages/acknowledgements that actually exist. They do
not watch worker process liveness, cron success, route traffic, or deployment
uptime as a proxy for output. Promtool tests prove failing and healthy zeros,
two facilities where only one is sick, two tenants with tenant-wide streams,
missing observation output, stale observation output, and the late-critical
page clearing only after an acknowledgement receipt.

## 8. §6.8 integrity, RLS, grants, and retention

Every new table, column, index, function, and evidence link follows the full
§6.8 posture:

- non-null tenant identity and rejection of the default-tenant sentinel;
- composite same-tenant offset/inbox/task/result/audit foreign keys and a
  same-tenant/facility key wherever the catalog entry is facility-bound;
- strict action/class/outcome/family/direction/scope/marker/state/actor/reason/
  timestamp/hash/critical-ID row-shape checks, all validated;
- tenant-aware primary, unique, partial-effect, and operational indexes;
- both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`;
- C3.1-style restrictive explicit-context policies so absent, empty,
  malformed, `bypass`, wrong-tenant, or wrong-facility context matches no row;
- no default/public table, sequence, or function grants;
- no runtime direct `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` on operator
  actions, awareness obligations, or acknowledgement receipts;
- narrowly validated migration-owned command/append functions with fixed
  `search_path`, exact typed inputs, current-context rechecks, and no caller-
  controlled SQL;
- append-only source binding, state snapshots, policy evidence, actions,
  refusals, obligations, acknowledgements, and clinical audit links;
- JSON never serving as sole authorization evidence;
- background observation through tenant-safe read authority only; metrics do
  not become a mutation or bypass path; and
- signed retention-policy identity/cutoff inherited from the exact offset/
  inbox evidence, with no new hard-coded retention duration.

No action, obligation, acknowledgement, linked inbox/offset/task/result, or
source-tuple tombstone may be deleted while its source can replay, its duplicate
identity protects retained evidence, its clinical review remains open, or its
signed retention binding is absent. Rollback disables new commands and pages;
it never deletes or rewinds evidence.

The existing event-offset and external-inbox RLS/grants remain at least as
restrictive. Step 2 moves the two operator transitions behind narrow migration-
owned functions and relational transition guards. Those commands become the
only runtime route to initial external-offset registration or
`paused -> replaying` authorization. Migration 603's worker-required cursor
columns remain usable only for the already-valid replay transitions; they
cannot satisfy the new operator-action guard or become an alternate/forgery
path for these two commands.

## 9. Mandatory tests and evidence

### 9.1 Command and idempotency tests

- exact duplicate registration and resume return one prior applied receipt;
- same key/effect with actor, role, family, direction, partition, generation,
  facility, marker, policy, reason, fingerprint, or expected state drift fails;
- concurrent exact commands converge on one applied state and receipt;
- registration creates only `paused` or
  `reconciliation_required_missing_marker` as server-derived;
- resume changes only the exact `paused` offset to `replaying` with the exact
  cutoff; another partition/generation is unchanged;
- transaction failure rolls back offset, operator action, and clinical audit;
- authenticated stale/mismatch/scope/policy refusal appends one safe refusal;
  unauthenticated or untrusted-tenant input cannot choose an evidence tenant;
- no list filter or body field can become predicate-bulk mutation; and
- current Admin/SUPER_ADMIN role, SUPER_ADMIN step-up, IP allowlist, tenant,
  signed evidence, and resource state are rechecked at act time.

### 9.2 Raw PostgreSQL and RLS negatives

Disposable raw-PostgreSQL tests create/use the production runtime roles and
prove at minimum:

- `vhhealth_app`/`vhhealth_runtime` still cannot directly insert or update an
  initial external offset, write a cutoff, or flip `paused -> replaying`;
- a forged action/audit JSON object, action table row, transaction-local
  command marker, or claimed current transaction cannot satisfy the transition
  guard or authorize replay;
- direct insert/update/delete/truncate of action, obligation, and
  acknowledgement evidence is denied;
- absent, empty, `bypass`, malformed, cross-tenant, cross-facility, wrong-
  family, wrong-direction, wrong-partition, wrong-generation, stale-state, and
  retired-offset contexts fail closed with the expected SQLSTATE/named
  constraint;
- tenant-scope/facility-ID and facility-scope/facility-ID mismatches fail the
  named CHECK/FK at the database, not only application validation;
- a forged late-critical obligation cannot bind the wrong inbox, task,
  patient, result array, family, or facility;
- a forged acknowledgement cannot use an unassigned actor, mismatched task,
  duplicate obligation, altered timestamp, or missing task acknowledgement;
- action/obligation/acknowledgement/source evidence is immutable and
  undeletable after application; and
- direct SQL remains denied after an applied action; there is no state rewind
  or second effect.

### 9.3 C-D8 and human-channel tests

- recovered critical I01 and I02 results atomically create the existing
  critical-priority duty-doctor task plus exactly one awareness obligation;
- the task remains no-SLA with no due time and continues to carry
  `late_pending_only`;
- the clinical-inbox task and rail badge render an explicit recovered-critical
  acknowledgement obligation without calling it a fresh alarm/breach;
- authorized acknowledgement atomically moves the task to `in_progress` and
  appends one receipt; duplicates do not duplicate either;
- an unacknowledged obligation emits the page series and an acknowledgement
  clears it on the next complete observation;
- `lab_critical_alerts`, `workflow_sla_instances`,
  `care_pathway_transition_events`, and `notification_outbox` remain unchanged;
- migration 603's effect triggers and migration 608's exact late-lab deferred
  guards keep their identities and remain enforced; and
- the live critical-result path still creates its normal alert/SLA/escalation,
  proving late and live paths have not converged accidentally.

### 9.4 Observability and build-wide gates

- metric unit/deep tests cover complete replacement, zeros, invalid/missing
  observation, stale-label removal, bounded labels, tenant-wide sentinel, and
  independent facilities/tenants;
- promtool rule tests cover every firing/non-firing case and exact labels;
- rule metadata verification and `rule-semantics.sha256` are refreshed from the
  final rules, not hand-waved;
- before any activation, the existing C1.3 live drill proves the real source
  series, rule, operations/PagerDuty/team receiver deliveries, external
  Watchdog, resolution, and named human acknowledgement; rule presence alone
  is not acceptance;
- fresh migration apply/re-run, runner smoke, regenerated Prisma, schema drift,
  comprehensive seed, and declared-empty policy all pass;
- both OpenAPI mirrors are generated together, byte-identical, live-route
  complete, stock-Spectral clean, baseline-neutral, and carry the four real
  operation descriptions;
- full backend lint/security/static checks and complete backend Jest inventory
  run on fresh PostgreSQL;
- full Admin lint/type-check/Jest/build and focused workbench tests pass; and
- shared-core plus Staff format/analyze/tests, focused clinical-inbox widgets,
  route-role policy, accessibility, and localization guards pass.

Focused tests alone are not completion.

## 10. Expected Step-2 responsibility ledger

This is a planning ledger only. It is re-derived from the cleared post-#737,
post-device-loss baseline.

| Area | Expected change |
|---|---|
| DDL/Prisma | One fresh migration; operator actions; critical-review obligations/acks; exact functions, constraints, RLS/grants/indexes; regenerated schema |
| Backend command surface | New operability service/validator/controller/Admin router wiring around the existing generic recovery service; structured clinical audit |
| Admin workbench | Extend the existing Continuity Reconciliation page/client/tests with one external-recovery tab and exact-item actions |
| Critical-results inbox | Extend the existing acknowledge path and typed task projection; no new route family or second queue |
| Staff/core | Recovered-critical copy/receipt state, existing inbox card/rail badge behavior, client/models/tests/localization |
| Observability | Complete external-recovery output probe/snapshot/serialization, reliability alert rules, promtool cases, metadata/hash, runbook |
| OpenAPI | Extend the existing clinical-continuity and clinical-inbox overlays; regenerate both mirrors as one artifact |
| Evidence | Unit/deep/raw-PG/RLS/idempotency/C-D8/metrics/full-suite receipts |

The expected paths include the existing Admin continuity-reconciliation page
and client, the existing downtime/reconciliation OpenAPI module, the existing
clinical-inbox OpenAPI module, `externalInterfaceRecoveryService.js`, the
clinical-inbox/task acknowledgement seam, reliability metric serialization,
backend reliability alerts/promtool tests, both generated OpenAPI mirrors, and
the then-current migration/Prisma pair. Whole-file paths are not frozen until
the serialized owners land.

## 11. Rollback

Rollback removes route exposure and Admin controls, disables the new output
collector/rules, and leaves the existing generic recovery core paused. It does
not delete, update, retire, rewind, or synthesize an offset, inbox item,
operator action, critical task, obligation, acknowledgement, audit row, marker,
cutoff, duplicate key, or source evidence. An offset already authorized by an
operator remains evidence requiring explicit owner reconciliation; rollback is
not reverse authorization.

The Staff inbox remains usable for already-created tasks. If the new
acknowledgement path is disabled, open obligations stay visible and are handled
under the rollback runbook; they are never marked acknowledged by deployment
state.

## 12. Explicit non-goals and coordinator gate

This delta and its future Step-2 slice do not:

- perform family activation or activate any partition, source connector, worker,
  scheduler, deployment, environment, secret, credential, provider, facility,
  or production overlay merely by being merged;
- add a global family-enable toggle or predicate-bulk registration/resume;
- weaken, bypass, rename, or conditionally disable the C-D8 effect fence;
- change cursor order, HWM/predecessor/duplicate semantics, ACK truth,
  generation rules, replay selection, lease rules, or cursor advancement;
- fabricate a missing marker, “start at current,” auto-authorize resume, or
  automatically requeue a held/dead item;
- create a retrospective `lab_critical_alerts` row, clinical SLA, pathway
  transition, patient notification, or fresh critical-alert event;
- create a second critical-results inbox, workflow engine, replay ledger,
  audit engine, or OpenAPI mirror;
- set a new clinical SLA duration, replay window, retention duration, or
  patient-facing threshold;
- merge this lane; or
- deploy or invoke the future operator commands.

Step 2 begins only after coordinator GO, #737 and the device-loss build have
cleared the serialized backend/migration lane, `github/main` has been re-
fetched, every open migration owner has been inventoried, and a fresh migration
number and file ledger have been recorded. Until then, **WAIT**.
