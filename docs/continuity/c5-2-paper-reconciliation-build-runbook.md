# C5.2 paper back-entry and reconciliation build runbook

Status: **validation-only, inert, and not production-ready**.

This runbook implements the coordinator-cleared
`c5-2-paper-reconciliation-design-delta.md`. It does not supply the unsigned
C0.3 hospital-area/platform classifications, the unsigned C-D14 operational
acceptance, activation authority, deployment authority, or readiness
attestations.

## 1. Authority and scope

- Baseline prerequisite: `github/main` at `37e137096` or later, containing C5.1.
- Migration: `606_clinical_continuity_paper_reconciliation.sql`, derived after
  the prerequisite rebase. No migration number was reserved.
- C5.1's `clinical_continuity_replay_receipts` remains the only command-effect
  receipt authority. C5.2 adds `paper_back_entry`; it does not add a paper
  receipt table.
- C6.1's `event_consumer_offsets` remains the interface HWM authority. C5.2
  reads and locks offsets during closure; it never resets or rewrites them.
- `tasks`, `workflow_sla_instances`, `clinical_audit_events`, the canonical
  clinical timeline, the event outbox, and `patient_merge_requests` remain the
  shared engines.
- The compile-time C-D14 acceptance constant is false. Even when every
  environment flag is true, the reconciliation command gate remains closed.

Every request is scoped by the authenticated tenant plus both facility-context
headers:

- `X-VH-Continuity-Facility-Id`
- `X-VH-Continuity-Facility-Context`

The second value is a short-lived, server-issued signed context obtained from
an enrolled managed device. Clients cannot assert tenant, role, grants,
ownership, device trust, policy, receipt outcome, or closure eligibility.
Staff and Admin keep the signed context in memory only.

Before a paper receipt is selected or its duplicate/mismatch state is exposed,
the server derives the patient from the locked paper item, rechecks the current
patient relationship and the exact action policy, and fails closed. A stale
capture-time authorization therefore grants neither current PHI visibility nor
command authority.

## 2. Closed API contract

All paths are below `/api/v1/downtime/reconciliation` and use the standard
C4.1 response envelope.

| Method and path | Purpose |
|---|---|
| `GET /workbench` | Facility-scoped incident, packet, paper, queue, identity, device, and interface view |
| `POST /incidents/declare` | Online signed packet declaration |
| `POST /incidents/import` | Offline signed packet declaration import |
| `PATCH /incidents/{incidentId}/state` | CAS transition to restored or reconciling |
| `POST /incidents/{incidentId}/range-disposition` | Append range-accounting decision and update its CAS projection |
| `POST /incident-aliases` | Append active or corrective split-brain alias evidence |
| `POST /incidents/{incidentId}/paper-items/{paperItemId}` | Register one paper identifier |
| `POST .../{paperItemId}/mar-administration` | Exact Ward medication-administration backfill |
| `POST .../{paperItemId}/lab-specimen-collection` | Exact Laboratory specimen-collection backfill |
| `POST .../{paperItemId}/blood-transfusion-verification` | Exact Blood Bank two-verifier backfill |
| `POST /reconciliation-items/{itemId}/decision` | Typed queue decision through existing task ownership |
| `PUT /incidents/{incidentId}/devices/{deviceId}/offset` | Device-journal HWM evidence |
| `PUT /incidents/{incidentId}/interfaces/requirement` | C6.1 interface-offset requirement |
| `POST /incidents/{incidentId}/identity-matches` | HIM proposal against an existing patient |
| `POST /identity-matches/{mergeId}/approve` | Distinct clinical coapproval |
| `POST /identity-matches/{mergeId}/execute` | Execute the approved temporary-identity alias |
| `GET /incidents/{incidentId}/closure` | Recompute and lock the closure predicate |
| `POST /incidents/{incidentId}/closure/attestations` | Operational or clinical key |
| `POST /incidents/{incidentId}/closure/close` | CAS close against the current predicate and both keys |

There is no generic replay/backfill action, transfer, admission, discharge,
notification, pathway-transition, SLA-alarm, or permanent-patient creation
route in this API.

## 3. Data, clocks, and retention

Incident headers, paper ranges/items, temporary identities, queue items, device
offsets, interface requirements, and reconciliation configuration are CAS
projections. Scope and identity are immutable, updates advance exactly one
version, and deletes are rejected. Incident-qualified composite foreign keys
prevent paper items, temporary identities, device offsets, merge evidence, and
retrospective facts from being attached to a different incident even inside the
same tenant and facility.

Declarations, aliases, range decisions, retrospective facts, reconciliation
decisions, closure attestations, and patient-merge decisions are append-only.
Signed incident packets permit one transition from `unused` to one terminal
state.

A successful paper fact is one serializable transaction containing:

1. the C6.1 `late_pending_only` session fence;
2. a C5.1 paper receipt claim;
3. the exact retrospective domain projection, or exact-projection recognition;
4. one retrospective fact;
5. one canonical timeline event and clinical audit event;
6. one event-outbox record carrying all no-retrigger suppressions;
7. one effect-evidence link;
8. the paper-item CAS update;
9. the terminal C5.1 receipt outcome and append-only attempt.

The Blood Bank adapter records retrospective verification evidence only. It
does not insert a live `transfusion_verifications` row, arm bedside completion,
or make a later physical transfusion executable without the normal live
verification path.

The clocks are distinct:

- `occurred_at`: when the physical action happened;
- `recorded_at`: server time when the retrospective fact became durable;
- `reviewed_at` / `decided_at`: later human governance time, never synthesized
  from either earlier clock.

Paper receipt acceptance is bounded to seven days, full C5.1 receipt evidence
is retained for 365 days, and compact tombstone identity is retained for 2555
days. Incident, declaration, paper, fact, task, audit, timeline, merge, and
closure evidence follows the governed clinical/audit retention path and cannot
be shortened through this workbench.

The live retention-class mapping is:

| Evidence | Retention class and C5.2 behavior |
|---|---|
| Incident declarations and aliases | Immutable continuity clinical evidence; no C5.2 delete, purge, or compaction path |
| Paper ranges and item ledgers | Paper inventory and clinical provenance; no C5.2 delete or tuple-rearming purge path |
| Temporary identities and merge evidence | Existing patient-identity and `patient_merge_requests` clinical evidence lifecycle; aliases and decisions remain append-only |
| C5.1 receipts and tombstones | Signed C-D10 class: accept through 7 days from capture, retain full receipt detail for 365 days from server receipt, retain tuple tombstone through 2555 days |
| Receipt attempts and effect evidence | C5.1 receipt/audit evidence plus linked clinical provenance; compaction cannot remove the deduplication tuple |
| Reconciliation decisions | Immutable continuity decision and clinical/audit evidence; no C5.2 delete path |
| Tasks, SLA instances, comments, and approvals | Existing task-engine retention and ownership lifecycle; C5.2 neither invents a due time nor shortens source retention |
| Clinical audit and timeline records | Existing clinical-audit and canonical-timeline evidence classes; append-only and not purged by C5.2 |
| Readiness and drill evidence | PHI-free repository/CI engineering evidence retained by the standard release-evidence process; it is not a runtime clinical-table purge authority |

Where an existing source engine owns retention, that source policy remains
authoritative. C5.2 introduces no new clinical/legal duration and no purge job.

## 4. Operator sequence

1. Confirm the validation banner remains visible and no activation control is
   present.
2. Obtain a fresh facility context from an enrolled managed device. Never copy
   it into tickets, logs, cookies, local storage, or screenshots.
3. Select the server-returned incident. Import only a signed packet whose
   reserved incident and range match the physical packet.
4. Restore the incident, then move it to reconciliation with the current
   server version.
5. Account for every issued, used, voided, lost, revoked, expired, and unused
   paper identifier. A lost or revoked identifier presented later is preserved
   and sent to safety review; it is never silently applied.
6. Register paper evidence and use only one of the three exact adapters. A
   tuple mismatch, domain-state conflict, or unresolved temporary identity is
   queued; do not retry with altered evidence to force acceptance.
7. HIM proposes a temporary-identity match. A distinct doctor or configured
   clinical safety lead coapproves it. Execution creates an alias to the
   existing patient and rewrites zero historical rows.
8. Resolve or explicitly hand off typed queue work through its canonical task.
   With no owner-approved SLA target, the task has `sla_completion_semantics =
   none` and no fabricated due time.
9. Reconcile device and interface HWMs. Recompute closure after any new offset,
   task, paper, identity, or range evidence.
10. The incident commander supplies the operational key and the configured,
    distinct clinical safety lead supplies the clinical key. Close only if the
    server recomputes the same unblocked snapshot.

Typed error codes, rather than message parsing, distinguish authorization
denial, stale projection, exact duplicate, mismatch/needs-review, invalid
packet/range, unresolved identity, closure blocker, and retryable failure.

## 5. Deterministic drill receipt

| Hard probe | Automated receipt |
|---|---|
| Duplicate valid commanders, split brain, duplicate import | `clinicalContinuityIncidentPaperDrills.test.js` |
| Lost and revoked ranges presented later | `clinicalContinuityIncidentPaperDrills.test.js` |
| Active alias, cycle rejection, corrective append without rewrite | `clinicalContinuityPaperReconciliationMigration.deep.test.js` |
| Exact duplicate and same-tuple mismatch | `clinicalContinuityIncidentPaperDrills.test.js`, `clinicalContinuityPaperTransactionAtomicity.test.js` |
| Eight concurrent identical submissions | `clinicalContinuityPaperTransactionAtomicity.test.js` |
| Cross-tenant and cross-facility isolation | `clinicalContinuityPaperReconciliationMigration.deep.test.js`, `clinicalContinuityIncidentPaperDrills.test.js` |
| Current-domain-state conflict | `clinicalContinuityPaperTransactionAtomicity.test.js` |
| Temporary identity proposal, distinct clinical coapproval, execution | `clinicalContinuityIdentityMerge.test.js` |
| Unauthorized and same-person identity coapproval | `clinicalContinuityIdentityMerge.test.js` |
| Three exact late facts; no physical reperformance or re-trigger | `clinicalContinuityPaperSchemas.test.js`, `clinicalContinuityPaperTransactionAtomicity.test.js` |
| Transfer payload cannot reach a handler | `clinicalContinuityPaperSchemas.test.js`, `clinicalContinuityPaperReconciliationGate.test.js` |
| Device HWM lag, interface HWM lag, and changed HWM | `clinicalContinuityClosurePredicate.test.js` |
| Unresolved safety-critical closure work | `clinicalContinuityClosurePredicate.test.js` |
| Same-person two-key closure attempt | `clinicalContinuityClosurePredicate.test.js`, `clinicalContinuityPaperReconciliationMigration.deep.test.js` |
| Receipt, fact, timeline, audit, and outbox crash/retry | `clinicalContinuityPaperTransactionAtomicity.test.js` |
| RLS, grants, append-only, CAS, packet terminality | `clinicalContinuityPaperReconciliationMigration.deep.test.js` |
| Staff generated-client and facility-header behavior | `http_client_test.dart` and Staff analyzer/localization gates |
| Admin signed-context proxy, route policy, accessibility, closure blocker UI | Admin continuity API/page/proxy tests |

The fault suite injects a crash after each authoritative boundary, asserts the
transaction leaves no receipt, domain projection, fact, timeline, audit,
outbox, effect evidence, or paper mutation, then retries to exactly one terminal
receipt/fact outcome. Exact and concurrent duplicates do not add a second
domain action, fact, or outbox event.

## 6. Hospital-area/platform classification blocker

The required inventory is 11 areas × 4 platforms = 44 owner classifications.
All cells remain **owner-classification-pending** because the signed C0.3 matrix
has not landed.

| Area | Android | Windows/desktop | Browser/web | iOS |
|---|---|---|---|---|
| Ward | pending | pending | pending | pending |
| Emergency department | pending | pending | pending | pending |
| Outpatient department | pending | pending | pending | pending |
| Theatre/operating room | pending | pending | pending | pending |
| ICU/NICU/PICU | pending | pending | pending | pending |
| Maternity | pending | pending | pending | pending |
| Cath lab | pending | pending | pending | pending |
| Dialysis | pending | pending | pending | pending |
| Pharmacy | pending | pending | pending | pending |
| Laboratory | pending | pending | pending | pending |
| Blood bank | pending | pending | pending | pending |

Ward medication administration, Laboratory specimen collection, and Blood
Bank transfusion verification are implemented adapter boundaries only. They are
not claims that any area/platform cell is owner-approved as included,
manual-only, or excluded. A Gate-complete or activation-ready receipt is
prohibited until every cell is signed and exercised or explicitly classified.

## 7. Rollback rehearsal

Rollback is forward-compatible and non-destructive:

1. Leave `CLINICAL_CONTINUITY_PAPER_RECONCILIATION_ENABLED=false` (or remove
   the route/workbench entry points in a code rollback).
2. Confirm the C-D14 compile-time gate remains false.
3. Do not reverse migration 606, delete schema objects, truncate evidence,
   reopen receipts, reset C6.1 offsets, detach task/SLA links, or rewrite
   aliases/merges.
4. Older application code has no grants to mutate the new tables. Preserve an
   authorized read/export path for incident and reconciliation review.
5. Forward-fix the defect, rerun the fresh-database migration, transaction
   fault suite, focused apps, backend shards, and hosted checks before a new
   validation build.

Rollback success means command entry points are unavailable while every
already-durable incident, receipt, attempt, paper item, fact, audit, timeline,
task, SLA, merge decision, offset requirement, and attestation remains intact.

## 8. Release receipt status

- Fresh-database migration through 606: required and automated.
- Schema drift, RLS/grant, OpenAPI drift/sync, focused tests, backend shard
  suites, Staff/Admin localization/accessibility, and hosted checks: required.
- Signed C0.3 classifications: **blocked / absent**.
- Signed C-D14 acceptance and operational/clinical readiness record:
  **blocked / absent**.
- Merge, deploy, activation, and production-readiness claim: **not authorized**.
