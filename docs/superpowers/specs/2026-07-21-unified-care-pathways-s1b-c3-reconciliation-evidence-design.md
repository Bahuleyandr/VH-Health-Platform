# Unified Care Pathways S1b-c3 — Reconciliation and Activation Evidence Design

**Status:** implementation design
**Grounding revision:** `2acff17b662fa91e11ffa870e402e247c05db8a7`
(`2026-07-21T13:19:50+05:30`)
**Intended branch:** `feat/care-pathways-s1b-c3-reconciliation-evidence`
**Migration reservation:** `587_care_pathway_reconciliation_evidence.sql`
**Program authority:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`
**Dependencies:** S1a through S1b-c2 / migrations 578–586

## 1. Outcome and safety boundary

S1b-c3 builds the versioned reconciliation and evidence rail that must exist before any tenant/pathway
can be considered for activation. It answers four questions without treating an absence of evidence as
success:

1. is every expected check registered and did every one execute;
2. does current source, pathway, task, SLA, handoff, projector and delivery state agree;
3. did this observation detect or repair any drift; and
4. has one unchanged implementation/governance set produced an owner-defined clean streak?

The slice remains activation-inert. It does not add a clinical pathway definition, pathway event handler,
clinical clock, threshold, escalation recipient, notification, patient projection, tenant setting write,
production activation capability or deploy. `off` remains the default mode; production `active`
execution remains unavailable. The evidence command is read-only and may report `FLIP-READY`, but it
cannot flip a setting or mint the executor's sealed activation capability.

The pathway observation sweep never creates work merely because a pathway is in `shadow`. A separately
allowlisted per-rule breach repair may correct an already-authoritative live SLA obligation only through
that rule/source's existing strict domain producer. It is disabled by default, is not pathway activation,
and any sweep that repairs state is non-clean. A later zero-drift observation is required.

Stroke and STEMI retain their own authoritative intra-encounter clocks under D8. Porter and
pending-target clocks likewise stay outside generic repair. OBGyn may later consume these rails but this
slice adds no OBGyn definition or second reminder/SLA engine. S1b-r remains responsible for mutating
outbox/projector recovery; S1b-c3 only detects and presents that debt.

## 2. Verified baseline

The following are repository facts at the grounding revision. Line numbers are evidence anchors, not
permanent identifiers.

- The canonical pathway keys are `diagnostics`, `referral`, `op`, `inpatient`, `ed` and `surgery`.
  Modes are `off|shadow|active`, and missing, malformed or failed settings resolve to `off`
  (`apps/backend/src/services/pathways/pathwayMode.js:4-22,54-81`).
- Active execution requires a sealed capability, while production code cannot mint one
  (`apps/backend/src/services/pathways/pathwayExecutorService.js:581-597,995-1004`). Care-pathway route
  inputs do not accept that capability
  (`apps/backend/src/routes/carePathwayRoutes.js:16-29,141-187`).
- The lossless projector substrate already has registered generations, offsets, commit-coupled inbox
  ingestion, leases, retries, dead state and a stale-lease reaper
  (`apps/backend/src/migrations/578_pathway_projector_inbox.sql:95-239`;
  `apps/backend/src/services/events/pathwayProjectorService.js:134-719`). The current generation contains
  only no-op shadow observers for six event types
  (`apps/backend/src/services/events/pathwayProjectorRegistry.js:11-18,116-137`).
- `withJobLock` combines an in-process guard with a dedicated-session advisory lock, but database lock
  acquisition fails open when that connection cannot be established
  (`apps/backend/src/utils/scheduler.js:43-178`). A reconciliation service therefore still needs a
  tenant/pathway transaction-level fence.
- The ledger precedent stores reconciliation rows and has a clean-streak reader
  (`apps/backend/src/migrations/349_reconciliation_checks.sql:1-27`;
  `apps/backend/scripts/ledger-reconciliation-evidence.mjs:17-57`), but ledger persistence is
  best-effort and swallows an insert failure
  (`apps/backend/src/services/billing/ledger/ledgerReconciliation.js:169-194`). Its 48-sweep/seven-day
  defaults are ledger choices, not care-pathway clinical or governance authority.
- The escalation engine discovers only `scope='task'` rules, treats an overdue active SLA as a query
  signal without changing its status, and hard-codes orphan repair to `critical_result_ack`
  (`apps/backend/src/services/workflow/escalationEngineService.js:406-507,558-638`). The code explicitly
  defers table-wide SLA status reconciliation.
- Existing critical-result producers are source-sensitive. For example, lab uses `source_table='lab_result'`,
  while investigation results use `resourceType='investigations'` and the ordering clinician
  (`apps/backend/src/services/lab/labCriticalAlertService.js:63-75,346-375`;
  `apps/backend/src/services/investigation/investigationService.js:950-989`). The shared producer can
  fall back to a DUTY role when no ordering clinician exists
  (`apps/backend/src/services/results/resultsInboxService.js:263-403`). A generic orphan repair could
  therefore violate D10 source ownership.
- Existing care-pathway readiness scripts intentionally do not claim activation readiness
  (`apps/backend/scripts/audit-care-pathway-spine-readiness.mjs:1484-1510`;
  `apps/backend/scripts/audit-care-pathway-owner-routing-readiness.mjs:705-715,867-885`).
- Reliability metrics cover event, notification, webhook and projector queues, but not care-pathway
  reconciliation (`apps/backend/src/observability/reliabilityMetrics.js:19-64,107-165`).
- The program requires registered per-pathway/per-rule checks, evidence-versioned rows and recovery
  tooling; an absent registry is an error, never clean evidence
  (`docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md:476-498,851-856`).

## 3. Complete immutable reconciliation registry

`pathwayReconciliationRegistry.js` is the sole source of executable reconciliation authority. It follows
the existing registered-runtime provenance pattern: construction validates all descriptors, freezes the
complete graph, brands the resulting object and exposes lookup only from that branded object. Callers
cannot pass an ad hoc array or function as a repair capability.

The registry contains exactly one entry for every canonical pathway key. Each entry declares:

- a stable pathway profile version;
- ordered common-check IDs and handler versions;
- exact definition/governance matchers supported by domain adapters;
- ordered pathway-specific check IDs and handler versions;
- exact SLA `(rule_code, source_table)` repair descriptors, if any;
- explicit domain-clock exclusions; and
- a blocking readiness reason while that pathway has no approved domain adapter.

Every check ID and `(rule_code, source_table)` pair is unique. There is no wildcard source, fallback
handler, default rule or “all current workflow rules” registration. `automation_rules` remains dormant and
non-authoritative under D2.

The registry exports a deterministic manifest made only from normalized descriptor data—not function
stringification—and a SHA-256 checksum over its canonical sorted representation. Any semantic handler
change requires a handler-version bump; conformance tests snapshot the manifest and fail when a changed
descriptor is not reflected in the version/checksum.

### 3.1 Runtime completeness

A structurally valid registry is not automatically activation-complete. For a tenant/pathway observation,
`registry_complete` is true only when all of these are true inside the same tenant transaction:

1. all six canonical pathway keys exist in the branded registry;
2. every currently startable approved governance/definition tuple matches exactly one registered domain
   adapter;
3. every expected check for those matches is present and executed exactly once;
4. every observed overdue SLA rule/source is either handled by one exact registered descriptor or is an
   explicitly owner-authorized domain-clock exclusion; and
5. the registry checksum used for execution is the checksum written to evidence.

No effective governance row, an unmatched definition, an unknown rule/source, an absent pathway entry,
duplicate registration or skipped check is blocking evidence. Unknown rules are findings and are never
auto-actioned. An explicit Stroke/STEMI/porter/pending-target exclusion prevents generic mutation but does
not assert those domain clocks are healthy; their owning-domain evidence remains separate.

### 3.2 Check families

The generic rail registers and proves common structural checks once:

- exact workflow run, pathway instance, definition/governance/checksum and creation-event pins;
- current-step/run agreement and canonical transition-event sequence integrity;
- duplicate active instances for one tenant/pathway/source episode;
- D10 instance/task/incomplete-SLA owner parity and current role-queue reachability;
- task/SLA/workflow-step and handoff/task/pathway linkage integrity;
- accepted handoffs whose required completion evidence is absent;
- projector registration, backfill, missing-inbox, dead-row and retired-generation debt; and
- event, notification, webhook and projector-inbox dead/stuck aggregate debt.

The vertical pathway slices register domain checks because only the owning domain can interpret:

- source records without pathway instances or instances without sources;
- a stage “stuck beyond policy” without inventing a time threshold;
- terminal source state while a pathway stage remains active;
- completed-but-not-acknowledged responses; and
- pathway-specific closure, reopen and exceptional-branch semantics.

If those checks are required by an effective definition but have not landed, the registry reports
incomplete and the sweep cannot pass. The generic rail never guesses domain SQL or declares an empty
domain profile clean.

## 4. Sweep execution and mode behavior

The scheduler registers one `care-pathway-reconciliation` job under `withJobLock`. The job is also behind
an exact environment opt-in that defaults false. Its cadence is operational evidence collection, not a
clinical SLA, and is configurable without being reused as an activation threshold.

The job enumerates tenants under the established super-admin bypass, then handles each tenant/pathway
independently. Each eligible observation executes through `setTenantTx` at serializable isolation and
acquires a deterministic tenant/pathway transaction advisory lock. A busy fence is recorded as a bounded
technical result or skipped; it is never counted as a clean observation. One tenant failure cannot stop
the remaining tenants.

Mode behavior is exact:

- `off`: perform no pathway reconciliation, repair, evidence insert or downstream action;
- `shadow`: run registered observations, write one evidence row, and create no pathway task,
  notification or patient projection; and
- `active`: because this slice provides no production activation authority, do not run mutation and
  persist/emit `ACTIVE_WITHOUT_ACTIVATION_AUTHORITY` as a blocking operational fault.

The service captures one database `now` at transaction start. Checks receive only the branded registry,
tenant/pathway context, transaction client, governance snapshot and captured time. They cannot open their
own transaction, use an unscoped Prisma client or enqueue best-effort side effects.

Common checks and domain checks return bounded structured results with stable codes and aggregate counts.
They never place patient identifiers, task IDs, free clinical text, raw SQL errors or stack traces in the
evidence JSON or metric labels.

## 5. Source-aware opt-in SLA breach repair

SLA breach repair is per rule **and** source, not table-wide. A descriptor is eligible only after the
owning domain supplies and tests all of:

- exact `rule_code` and `source_table` values;
- a bounded candidate query;
- a source existence and terminal-state validator;
- the D10-correct named-owner/role resolver for that source;
- the existing strict task materializer that accepts the caller's transaction; and
- a stable handler version and explicit repair opt-in.

For an eligible candidate, the handler locks the SLA/source contract, revalidates source ownership, and
uses a compare-and-set update restricted to `status='active'`, `completed_at IS NULL` and `due_at < now`.
It sets breach evidence once and invokes the same source producer in strict mode inside the transaction.
It does not insert a generic task, use the shared producer's DUTY fallback unless that exact source policy
explicitly authorizes a role queue, reopen a completed SLA, change clinical timing or infer an escalation
recipient.

The entire SLA transition, task materialization and evidence insert commits or rolls back together. A CAS
loser re-reads and records the resulting state without duplicating work. A missing source, owner mismatch,
unregistered source, terminal source or producer refusal is a finding with no mutation.

The initial production registry may contain no repair-enabled live rule until a source-specific handler
has completed its domain review. The repair kernel is proven with sealed test fixtures; enabling a live
descriptor is an explicit later registry change. This prevents the current hard-coded
`critical_result_ack` backfill from becoming accidental authority over investigation, NEWS2, radiology or
pathology ownership.

Any observation in which `repair_count > 0` is non-clean even if every repair succeeds. A later sweep over
the unchanged registry/governance set must observe zero drift before contributing to an activation streak.

## 6. Migration 587 evidence contract

Migration 587 creates append-only `care_pathway_reconciliation_checks`. It does not alter migrations
578–586, backfill clinical state, seed a pathway definition or change a tenant setting.

Each row records:

- `id BIGSERIAL`, `sweep_id UUID`, `tenant_id UUID`, `pathway_key` and observed `pathway_mode`;
- registry version and SHA-256 checksum;
- a SHA-256 checksum and count for the complete current governance set;
- the number of governance tuples covered by registered adapters;
- expected and executed check counts;
- finding, repair and error counts;
- `registry_complete`, `passed`, bounded `check_results JSONB`;
- captured start/completion timestamps and row creation timestamp.

The governance-set checksum is computed from the canonical sorted tuples
`(governance_id, workflow_definition_id, workflow_definition_version, definition_checksum)` for every
currently startable approved definition. It represents the full set, not an arbitrary “latest” row. The
empty set has a deterministic checksum but `governance_count=0` can never pass. Any governance or
definition change creates a different evidence cohort and resets the clean streak.

Database constraints require canonical keys/modes, lowercase hexadecimal checksums, nonnegative counts,
valid JSON shape and exact pass semantics. `passed` can be true only when:

- mode is `shadow`;
- the registry is complete;
- at least one governance tuple exists and every tuple is covered;
- expected checks are nonzero and equal executed checks; and
- finding, repair and error counts are all zero.

The row is inserted in the same tenant transaction as every successful observation or repair. Evidence
persistence is not best-effort. If the transaction aborts, all repairs roll back; a separate tenant-scoped
transaction may append one sanitized non-pass technical-error row, but it cannot preserve partial repair.

The table has a unique tenant/pathway/sweep key, latest-evidence and checksum-cohort indexes, a composite
tenant foreign key, application/sequence grants, Pattern-A RLS with both `USING` and `WITH CHECK`, and a
trigger rejecting update/delete. Retention remains an unresolved owner policy, so this slice adds no purge
job or deletion exception. Prisma is regenerated from the applied raw migration.

## 7. Read-only activation evidence command

`care-pathway-reconciliation-evidence.mjs` is a read-only verdict command. It takes an exact tenant and
pathway plus all activation-window values explicitly:

- minimum clean sweeps;
- minimum clean span;
- minimum separation between counted sweeps;
- maximum allowed gap; and
- maximum evidence age.

There are no care-pathway defaults and no values copied from the ledger script. A missing, zero or invalid
argument returns `NOT READY`. These values require clinical/governance/operational sign-off before use;
engineering does not infer them.

The command loads the current registry manifest, current tenant mode and current governance-set checksum.
It considers only the newest contiguous cohort with exact registry and governance checksums. It counts
only sufficiently separated observations, breaks on a failed/error/repaired/incomplete row or excessive
gap, requires current `shadow` mode and fresh evidence, and rechecks projector generation/backfill debt.
It prints the evidence IDs/checksums and a reasoned verdict without patient data.

Exit zero means only `FLIP-READY FOR OWNER REVIEW`; it is not a mode change or activation approval. Every
other outcome exits nonzero. The command contains no `UPDATE`, no settings service call and no activation
capability import. The later GO_LIVE registry owns any separately reviewed and audited flip.

## 8. Bounded observability

Reliability collection adds fixed-series gauges with `pathway_key` as the only dynamic label:

- failing shadow tenants;
- technical-error tenants;
- total current findings and repairs;
- age of the latest compatible evidence; and
- tenants configured active without activation authority.

All six pathway labels are set on every collection, including zero, because the current gauge primitive
has no reset operation (`apps/backend/src/observability/metricPrimitives.js:82-104`). Tenant IDs, check
IDs, source types, resource IDs and patient identifiers are prohibited metric labels.

Prometheus rules alert on nonzero technical errors and active-without-authority. Projector dead/retired
debt is also made operationally visible. Evidence age is exported but receives no alert threshold until
the owner approves one. Ordinary pre-pilot “not ready” findings remain dashboard evidence rather than a
page.

## 9. Read-only workbench and recovery boundary

S1b-c3 exposes an ADMIN/SUPER_ADMIN read-only backend workbench for latest/history evidence. It returns
mode, registry/governance checksums, counts, stable finding codes and timestamps. It does not return
patient identifiers, clinical text or raw candidate rows, and it has no POST/PATCH/DELETE operation.

The workbench cannot mark a row passed, dismiss a finding, reset an SLA, reassign a task, redrive a queue
or change a tenant mode. A future typed remediation action must re-resolve its source under tenant scope,
require a reason, use compare-and-set state transitions and append domain/audit evidence. Generic SQL
repair and bare queue-status reset remain forbidden.

Event-outbox processing leases, stale-processing reaping, atomic subscription fan-out, webhook uniqueness
and reasoned redrive remain S1b-r. Projector-inbox redrive likewise requires a typed audited recovery
contract. S1b-c3 reports their dead/stuck counts but does not claim recovery is built.

## 10. Verification and exit contract

The conformance suite must prove:

- the registry contains all six canonical pathway keys, is immutable/branded and rejects duplicates,
  wildcards, unknown keys, missing handlers and unversioned descriptors;
- an absent/incomplete registry, unmatched effective definition, unknown rule/source, skipped check or
  zero-governance set cannot pass;
- registry or governance checksum change starts a new evidence cohort;
- `off` performs no work and accidental `active` fails closed without acquiring activation authority;
- scheduler and tenant/pathway fences prevent concurrent observations from inflating a clean streak;
- cross-tenant reads/writes fail under Pattern-A RLS;
- every repair is source-aware, compare-and-set, atomic with evidence and non-clean;
- producer failure, evidence failure and forced canonical write failure roll back every repair;
- Stroke/STEMI/porter/pending-target and unknown rules are never mutated;
- evidence JSON, logs, metrics and workbench responses contain no PHI or unbounded labels;
- explicit CLI thresholds, spacing, gaps, freshness and checksum cohorts are enforced; and
- no route, script, setting or service can enable production `active` execution.

S1b-c3 is complete when the generic rails are green, migration/Prisma/schema drift checks pass, the
read-only evidence and workbench surfaces are verified, and production remains inert. It does **not** make
any pathway activation-ready by itself. S2 and later vertical slices must add their approved definitions,
source adapters, closure checks and any reviewed live rule handlers, then collect owner-signed evidence.
