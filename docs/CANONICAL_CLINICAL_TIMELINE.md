# Canonical Clinical Timeline

Last updated: 2026-06-07.

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
