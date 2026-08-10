# Canonical Clinical Timeline

Last updated: 2026-07-28.

This document is a durable engineering note for future Codex, Claude, Cursor,
and human contributors. VH Health now has a canonical clinical event layer. Do
not add new OP/IP clinical workflows that only write to their feature-specific
tables.

## Source Of Truth

Every patient-facing clinical action must be represented in the canonical
patient timeline:

- `patient_encounters`
- `clinical_timeline_events`
- `clinical_audit_events`
- `workflow_sla_rules`
- `workflow_sla_instances`
- `medication_safety_reviews`

The migration that creates this foundation is:

```text
apps/backend/src/migrations/269_canonical_clinical_platform.sql
```

The backend helper/service layer is:

```text
apps/backend/src/services/clinical/canonicalClinicalPlatformService.js
apps/backend/src/services/clinical/canonicalOperationalBridgeService.js
```

The intended read endpoint is:

```text
GET /api/v1/patients/:uid/timeline
```

Legacy timeline routes may remain as compatibility aliases, but new Staff and
Admin screens should prefer the canonical endpoint.

The platform support endpoints are:

```text
GET  /api/v1/encounters/:id
POST /api/v1/encounters/:id/activate
POST /api/v1/encounters/:id/sign
POST /api/v1/encounters/:id/amend
POST /api/v1/encounters/:id/lock
GET  /api/v1/encounters/:id/audit
GET  /api/v1/encounters/:id/slas
GET  /api/v1/encounters/:id/medication-safety
POST /api/v1/encounters/:id/medication-safety/evaluate
POST /api/v1/encounters/medication-safety/evaluate
GET  /api/v1/encounters/documentation/templates
GET  /api/v1/encounters/downtime-policy
GET  /api/v1/rbac/policy
```

The Staff typed model/service layer is:

```text
apps/staff/lib/core/models/clinical_platform_models.dart
apps/staff/lib/core/services/clinical_platform_api_service.dart
```

Keep these typed models ahead of UI work. Avoid adding new Staff screens that
parse canonical platform responses directly from ad hoc maps unless the model
is being added in the same change.

## Non-Negotiable Invariant

Feature tables remain useful as detail tables, but they are not the complete
patient story by themselves.

When a workflow successfully creates, edits, signs, locks, acknowledges,
dispenses, completes, cancels, or overrides a patient-related clinical item, it
must write all required records in the same transaction:

1. The feature/detail row, such as an OP note, prescription, investigation,
   referral, vital, I/O entry, MAR administration, discharge blocker, or bed
   cleaning task.
2. Exactly one canonical `clinical_timeline_events` row for the patient-facing
   timeline.
3. Exactly one `clinical_audit_events` row for traceability.
4. A `workflow_sla_instances` row when the action starts an SLA-backed workflow
   such as referral response, critical result acknowledgement, bed cleaning, or
   discharge blocker resolution.
5. A `medication_safety_reviews` row when prescription or medication-order
   safety checks produce findings or an override.

If any one of these writes fails, the workflow should roll back rather than
leaving the detail table and timeline/audit layer out of sync.

## Database-Level Append-Only Enforcement

Both canonical event tables are append-only at the database layer, enforced
by the shared `audit_append_only_guard()` BEFORE UPDATE OR DELETE trigger:

- `clinical_audit_events` — since migration 324 (audit-table hardening,
  platform audit 2026-06-18 §3).
- `clinical_timeline_events` — since migration 599 (2026-07-28
  canonical-timeline review; previously the timeline half was only protected
  indirectly by downstream ON DELETE RESTRICT composite FKs and the
  row-scoped guards from migrations 581/584/595).

The guard blocks UPDATE and DELETE for every role unless one of two escape
hatches applies:

1. `SET LOCAL app.audit_bypass = 'on'` — an explicit, transaction-local
   maintenance opt-in (equivalently
   `set_config('app.audit_bypass','on',true)`). The audit retention purge
   (`auditRetentionService`) uses this for the audit tables; **no production
   code path mutates `clinical_timeline_events` today** — the retention sink
   list deliberately excludes the timeline because it is clinical record,
   not an audit log. Any future timeline maintenance job must set this GUC
   inside its own transaction and be documented here.
2. The effective role is a superuser — the accepted threat boundary (a
   superuser can drop the trigger anyway). The prod app role is NOSUPERUSER
   NOBYPASSRLS, so app-level DB write cannot bypass. This branch is what
   keeps superuser-connected test-fixture cleanup working; non-superuser
   test paths use `src/tests/helpers/auditBypass.js`.

Corrections to timeline history are therefore compensating events or new
revisions under the idempotency-key discipline below — never in-place edits
or deletes. Pinned by `src/tests/canonical-timeline-append-only.deep.test.js`
and `src/tests/audit-append-only.deep.test.js`.

## Idempotency-Key Discipline

`clinical_timeline_events.idempotency_key` and
`clinical_audit_events.idempotency_key` are unique. The timeline writer
absorbs a duplicate key via `ON CONFLICT (idempotency_key)` and the audit
writer via a `DO NOTHING` + readback, so a key that repeats never records a
second revision. That absorption is a feature for exact retries and a defect
for genuine mutations — pick the key family accordingly:

- **Insert-once lifecycle events** use a fixed key,
  `<detail_table>:<id>[:qualifier]` (for example
  `maternity_deliveries:<id>:recorded`). Correct only while the emit runs
  exactly once per detail row — in the same transaction as the INSERT that
  mints the id — and the record has no in-place amendment/correction path.
- **Amendable records** (anything whose mutation path re-emits for the same
  detail row) must use the PR #589 revision pattern:
  `<detail_table>:<id>[:qualifier]:<state-fingerprint>:tx:<xid8>`, where the
  `:tx:` suffix comes from
  `canonicalClinicalPlatformService.currentCanonicalTransactionRevision(tx)`
  inside the same tenant transaction, paired with an effective-state no-op
  guard under a `FOR UPDATE` lock so exact retries return before any write.
  Without the `:tx:` suffix, an A->B->A edit sequence regenerates revision
  1's key on the return to A and the third revision is silently absorbed.

The coupling rule: **a fixed key is a claim that the record is insert-once.**
Adding any amendment, correction, or reopen path to such a record invalidates
that claim — the new mutation path must either move the emit to the
fingerprint + `:tx:` pattern or emit a distinct qualifier for the new
lifecycle event. Never let a mutation re-emit an existing fixed key.

Sites audited insert-once on 2026-07-14 (post-#589 adjacent-site audit):

| Emit site | Fixed key | Why insert-once holds |
| --- | --- | --- |
| `maternityService.recordDelivery` | `maternity_deliveries:<id>:recorded` | No UPDATE/DELETE path in product code; routes are POST + GET only. |
| `maternityService.recordNewborn` | `maternity_newborns:<id>:recorded` | Emit runs once in the tx that mints the row (D7 Shape-3 identity build); no UPDATE/DELETE path in product code (routes are POST + GET only), and outcome corrections are compensating events (B-c1), never in-place edits. |
| `maternityService.recordPartographEntry` | `maternity_partograph_entries:<id>:recorded` | Append-only observation series; corrections are new entries. |
| `maternityService.admitToLabor` | `maternity_labor_admissions:<id>:recorded` | Sole post-creation write is the one-way `active->delivered` transition inside `recordDelivery` (guarded, irreversible, surfaced via the delivery event's `afterState`); it never re-emits this key. |
| `maternity/immunisationService.markScheduleUpToDate` | `clinical_notes:<review.id>:immunisation_review` | Note is born signed; `immunisation_review` is not an editable note type in `clinicalNotesService` (rejected before the admin override — pinned by `src/tests/unit/clinicalNotesUpdate.test.js`), addenda create new rows, repeat reviews insert new rows. |
| `maternityService.recordPostnatalVisit` (maternal pair) | `maternity_postnatal_visits:<id>:mother:recorded` | Visits are point-in-time rows: POST + GET routes only, no UPDATE/DELETE path in product code. The `mother`/`infant` scope qualifiers keep the B-i dual pairs of a `'both'` visit (D7, signed 2026-07-15) on distinct per-subject keys against one detail row. |
| `maternityService.recordPostnatalVisit` (infant pair) | `maternity_postnatal_visits:<id>:infant:recorded` | Same insert-once argument as the maternal pair; subject is the newborn's own E-3-validated identity. |
| `icuService.createAdmission` | `icu_admissions:<id>:icu.admission_created` | Emit runs once in the tx that mints the admission id; no product path re-creates an admission row. |
| `icuService.dischargeAdmission` | `icu_admissions:<id>:icu.discharged` | active→closed is one-way: the state guard 409s any repeat discharge, so the emit runs at most once per admission (death uses the same key family with event type `icu.death_recorded`). |

ICU code-status (DNR) flips are amendable and use the fingerprint + `:tx:`
pattern (`icu_admissions:<id>:code_status:<status>:tx:<xid8>`) with an
effective-state no-op guard under `FOR UPDATE`, plus an append-only
`icu_code_status_history` row per flip (migration 648).

Families already on the fingerprint + `:tx:` pattern (PR #589): ANC visits,
maternity supplements, supplement reminder preferences, fetal-kick logs,
maternity newborn doses, paediatric unlinked patient doses, maternity Apgar
scores (D7 M-C rework — the `(newborn_id, time_minute)` UPSERT makes the row
amendable).

## Encounter Lifecycle

OP and IP work should attach to a formal encounter whenever possible.

Allowed lifecycle language:

```text
open -> active -> signed -> amended -> locked
```

Guidance:

- `open`: created from appointment, admission, or explicit clinical intake.
- `active`: the clinician is working in the encounter.
- `signed`: clinical entry is completed and should no longer be edited in place.
- `amended`: later correction/addendum linked to the signed encounter.
- `locked`: final immutable state except through an auditable amendment path.

OP consultations should not create multiple independent notes or prescriptions
for the same visit. Prefer one active note and one active prescription per
encounter, editable while the encounter is still open/active, then sign/lock
with audit history.

## Medication Safety

Medication safety runs through `validatePrescriptionSafety(...)` and canonical
review persistence. The first-trial local engine is expected to cover:

- structured and recent-note allergy conflicts
- duplicate active therapy
- pediatric dose sanity checks
- bleeding-risk antithrombotic interactions
- pregnancy medication risk
- renal medication review
- antibiotic duration, reserve-drug, and duplicate-spectrum stewardship prompts

Severe blockers must require a clinician override reason. Non-blocking warnings
must still be recorded and visible in the encounter medication-safety feed.

## Workflow SLA

SLA-backed workflows should start or complete `workflow_sla_instances` through
the canonical helper layer. Current SLA classes are referral response, critical
result acknowledgement, bed cleaning, discharge blockers, and operational
handoff blockers. Dashboards may render their own views, but the canonical SLA
table is the normalized source for audit and escalation proof.

## Downtime And Templates

Downtime/offline mode is deliberately conservative:

- cached reads and low-risk drafts can remain available
- vitals, I/O, nursing notes, handover, and housekeeping status drafts can be
  queued
- prescriptions, drug charts, investigations, referrals, and safety-sensitive
  actions may be local drafts only until online validation runs
- prescription signing/dispense, medication-safety override, critical result
  acknowledgement, break-glass, admissions, bed movement, discharge finalization,
  billing receipt, and role changes are blocked offline

Clinical documentation templates are structured prompts, not mandatory prose.
They should guide OP consultation, IP progress, referral request, handover, and
procedure notes without blocking necessary free text.

## Role Policy UI

`/api/v1/rbac/policy` owns the policy version/hash, roles, capability groups,
and Staff feature IDs. Flutter may keep a static fallback so the app can start
offline, but role-specific sidebar/workbench visibility should prefer backend
policy feature IDs whenever the policy endpoint is available.

## Timeline Event Coverage

These workflows should emit canonical timeline and audit events:

- OP consultation notes, prescriptions, investigations, referrals, follow-up,
  and appointment completion.
- IP vitals, I/O, notes, orders, MAR, handover, discharge readiness, and
  discharge completion.
- Pharmacy order, preparation, dispense, partial dispense, unavailable, and
  cancellation events.
- Lab/radiology order, collection, started, confirmed, resulted, critical
  alert, acknowledgement, and signoff events.
- Bed allocation, transfer, cleaning requested, cleaning started, cleaning
  completed, and bed made available.
- Patient-app activity and wearable summaries such as steps, walking distance,
  sleep, active energy, home vitals, symptoms, and device observations. These
  must be labelled as patient-generated or device-synced and unverified until a
  clinician reviews them. Continuous activity streams should be aggregated by
  day for the Staff timeline instead of writing one timeline row per raw sample.
- Access decisions and break-glass actions that affect PHI access.

## Access And Audit Relationship

The canonical timeline is not a permission bypass.

Patient access still goes through:

```text
RBAC outer gate
AccessDecisionService / relationship check
care-team, appointment, admission, referral, guardian, or break-glass context
```

The timeline endpoint should return only events the caller is allowed to see.
Every sensitive view/open action should be auditable. Every sensitive write
should emit a canonical clinical audit event.

## Staff App Guidance

The Staff app should treat OP Workspace and Patient Command Board as the main
clinical surfaces:

- OP Workspace reads and writes through encounter/timeline-aware endpoints for
  notes, prescription, investigations, referrals, follow-up, and visit status.
- Patient Command Board reads and writes through the same canonical IP timeline
  paths for vitals, I/O, notes, orders, MAR, handover, and discharge readiness.
- Bed Board should consume the same IP patient/timeline data and should not keep
  a separate vitals or notes data path.

If Flutter needs local models, prefer typed clinical models over loose
`Map<String, dynamic>` call sites for canonical timeline, encounter, medication
safety, SLA, and audit endpoints.

## Seeding And Test Data

The Dalekdefender database was cleaned on 2026-06-07 for fresh workflow testing
while preserving staff users/roles, wards, and beds. Old patient records,
appointments, admissions, notes, prescriptions, investigations, and legacy
timeline-like data were intentionally removed.

When adding new seed data, create it through the normal workflow paths where
possible so canonical timeline and audit events are generated. Avoid raw seed
inserts that create patient-facing detail rows without canonical timeline
events unless the seed script explicitly backfills them in the same run.
