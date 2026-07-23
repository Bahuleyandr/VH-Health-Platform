# Unified Care Pathways S4 — Outpatient and Inpatient Design

**Status:** Approved decisions implemented behind `off|shadow|active`; no production activation in this slice  
**Baseline:** `github/main` `2cf14b2329867fe8706b3316d407468768bd32ab` (2026-07-23T14:23:08+05:30)  
**Branch:** `feat/care-pathways-s4-op-inpatient`  
**Migration:** `595` (next free after `594_referral_closed_loop.sql`)  
**Parent design:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## 1. Outcome

S4 adds the two remaining non-emergency recovery pathways:

- `op_contact_to_recovery`
- `inpatient_admission_to_recovery`

Appointment completion continues to close the visit, not the pathway. The OP pathway closes only after clinician disposition, patient-safe next steps, and either completed child work or accepted named ownership elsewhere are durable.

Discharge readiness remains authoritative. In `active` mode, a pending result no longer blocks discharge merely because it is pending. It blocks when its exact source, signed-summary disclosure, and exclusive named physician ownership are incomplete. Formal medication reconciliation, follow-up booking or an audited exception, and the existing discharge gates remain required.

This slice publishes no pathway definition, changes no tenant mode, sends no production notification, and invents no clinical SLA, business-hours rule, reminder cadence, post-discharge contact timing, or escalation recipient.

## 2. Verified baseline and design corrections

The implementation is pinned to the baseline above. File symbols are authoritative; line numbers below describe that revision.

### 2.1 OP lifecycle is fragmented

Appointment creation, confirmation, no-show, completion, cancellation, and two reschedule meanings are spread across `appointmentService.js` and `appointmentWorkflowController.js`. The generic status writer has no tenant predicate, row lock, source-state guard, status history, canonical timeline/audit event, or durable outbox event (`apps/backend/src/services/appointment/appointmentService.js:577-590`). The OP workspace uses that generic writer to complete a visit (`apps/staff/lib/features/opd/screens/op_doctor_workspace_screen.dart:594-617`).

S4 introduces one tenant-scoped transition seam. Every S4-supported lifecycle mutation writes the appointment detail, status history, canonical clinical event, and transactional outbox event together. Existing token, queue, scheduling, and replacement-appointment behavior remains domain-authoritative.

### 2.2 Existing resource pointers do not prove lineage

The conditional resource-reference table in the parent design is required for S4:

- `e_prescriptions.appointment_id` is a soft pointer and may later identify a downstream follow-up appointment.
- investigations have an optional, non-FK appointment ID and alternate writers omit it.
- clinical and radiology order encounter identifiers are unconstrained and use incompatible namespaces.
- referral appointment linkage can identify the downstream referral booking rather than the originating visit.
- follow-up origin fields are free polymorphic strings without a resolver.
- normal admissions do not create a guaranteed `patient_encounters` row.
- OP admission advice is cleared post-commit and retained only in best-effort audit metadata.

Tasks remain mutable operational work and are not durable lineage.

### 2.3 Admission and discharge have safety gaps

`admissionService.admitPatient` is the canonical ADT path, but `bedService.admitPatient` creates a smaller admission without all canonical doctor, consent, complaint, and readmission checks. S4 must not project this quick-admit path as equivalent clinical acceptance.

Current readiness reconstructs pending investigations and radiology from patient/time queries, omits Anatomical Pathology, caps returned identifiers, and has no durable named owner. It hard-blocks any pending result (`apps/backend/src/services/emr/admissionService.js:2561-2595`). Medication reconciliation exists as a formal domain model but is not a readiness requirement. Follow-up query failure is caught and skipped.

### 2.4 Existing rails remain authoritative

- The event-outbox cursor/projector pipeline remains the only S4 event-consumption substrate.
- `care_pathway_instances`, transition events, handoffs, tasks, SLAs, governance pins, and reconciliation evidence remain the execution spine.
- Stroke/STEMI stay authoritative for their intra-encounter clocks.
- OBGyn remains rails-first and builds no second reminder or pathway engine.
- The current Discharge Hub, admission/discharge service, appointment domain, diagnostic generations, referral closed loop, and patient signed-summary boundary remain authoritative domain surfaces.

## 3. Mode behavior

| Mode | Domain writes | Projection | Tasks/notifications | Terminal enforcement | Patient projection |
|---|---|---|---|---|---|
| `off` | Existing behavior only | None | None from S4 | Existing behavior | Existing behavior |
| `shadow` | Existing behavior plus transactional source events | Durable shadow instance, references, transitions, and reconciliation findings | None from S4 | Report what would block; do not change the terminal action | No new dynamic pathway item |
| `active` | Same source writes | Evidence-gated runtime execution | Registered task/SLA effects only; notification intent only where an approved policy exists | Fail closed on S4 closure/readiness rules | Allowlisted safe projections only |

Production `active` execution remains intentionally unavailable until a separate evidence-to-capability authority is built. The existing operator tool continues to permit only `off` and `shadow`.

Mode is resolved inside the same branded tenant transaction as every safety-critical decision. Shadow mode must never be used as a synonym for active domain mutation.

## 4. Durable S4 data

### 4.1 Typed resource references

Migration 595 adds `care_pathway_resource_references`, an append-only projection ledger.

Required fields:

- UUID identity, tenant, pathway instance, and patient
- closed `resource_type` allowlist:
  `appointment`, `admission`, `e_prescription`, `clinical_order`, `investigation`,
  `lab_result`, `radiology_order`, `anatomical_pathology_case`,
  `diagnostic_result_generation`, `referral`, `follow_up_plan`, `clinical_note`,
  `discharge_summary`, and `discharge_consult`
- closed `relationship_kind`: `child_action` or `closure_evidence`
- closed evidence state: `open`, `completed`, `ownership_accepted`, or `superseded`
- resource identifier and optional accepted owner/task/handoff evidence
- source outbox event and canonical timeline/audit identifiers where available
- actor UID XOR registered system actor
- occurrence/recording timestamps, idempotency key, and optional superseded-reference ID

It has a composite `RESTRICT` foreign key to the exact tenant/pathway/patient instance, forced tenant RLS, unique idempotency, useful instance/resource indexes, and an UPDATE/DELETE blocker.

A closed resolver exists for every resource type. It rejects a missing row, wrong tenant, or wrong patient. Appointment resolution converts `appointments.patient_id` through `users.uid`. No caller may insert an arbitrary type/table pair.

The authoritative clinical mutation and source outbox event commit in one domain transaction. The projector then resolves the row and commits the pathway transition plus typed reference in one projector transaction. Legacy rows with no explicit origin are reconciliation debt; they are never inferred from patient/time proximity.

### 4.2 OP closure evidence

Migration 595 adds an append-only, revisioned `op_visit_closure_evidence` record keyed to a tenant appointment and patient. It records:

- the clinician who recorded the disposition;
- whether follow-up is clinically required;
- an optional linked follow-up plan;
- patient-safe next steps;
- closure basis: all required work completed, named ownership accepted, or accepted transfer;
- optional accepted handoff evidence;
- source appointment revision/idempotency and canonical evidence IDs.

The evidence service validates tenant, patient, clinician, follow-up, and handoff identity. It does not infer that follow-up is required and does not supply a due date.

### 4.3 Inpatient ownership and pending results

Migration 595 adds:

- a versioned `inpatient_primary_physician_assignments` domain record;
- `discharge_pending_result_handoffs`, one durable item per admission and typed pending-result source;
- append-only `post_discharge_contact_events` for manually or policy-triggered contact attempts/outcomes, with no default due time.

The initial primary physician is the explicitly valid same-tenant attending physician, falling back to the explicitly valid admitting physician only when no attending physician was recorded. Once a named physician is supplied, invalidity fails closed; it never silently degrades to a role queue.

Responsibility changes require an accepted, audited covering-clinician handoff. A pending-result handoff snapshots the exact source type/id, patient-safe label, current status, named physician, signed-summary inclusion evidence, linked task, notification-intent receipt, and resolution/generation evidence. The row is mutable operational truth; every transition also produces append-only pathway/canonical evidence.

The pending-result collector is tenant-scoped and typed across investigation/laboratory, radiology, and Anatomical Pathology sources. It never treats patient/time proximity as lineage. Sources that cannot prove admission membership become reconciliation findings and cannot satisfy the active-mode handoff gate.

## 5. OP pathway

### 5.1 Source events

Generation 4 consumes transactional OP events:

- `appointment.created`
- `appointment.confirmed`
- `appointment.checked_in`
- `appointment.in_progress`
- `appointment.completed`
- `appointment.cancelled`
- `appointment.no_show`
- `appointment.rescheduled`
- `appointment.admission_advised`
- `appointment.surgery_advised`
- `appointment.follow_up_recorded`
- `appointment.closure_evidence_recorded`

The event identifies the resource. Registered handlers reload durable domain evidence and never trust a signal payload for clinical decisions.

### 5.2 Definition

`op_contact_to_recovery` v1 has registered conditions/actions only:

1. observe contact and accountable named clinician;
2. observe arrival/start or a recovery branch;
3. observe visit completion without treating it as pathway closure;
4. wait for signed/recorded disposition and patient next steps;
5. require each blocking child complete or accepted named ownership/transfer;
6. finalize.

No numeric due time exists in the definition. No-show/cancellation recovery may materialize a named-owner task only in active mode and only without an unsigned SLA.

### 5.3 Appointment transition seam

The supported transition graph is explicit. Dedicated and generic routes call the same service. Terminal states cannot transition back through a generic update. Replacement reschedule remains distinct from same-row schedule correction and retains durable parent/replacement evidence.

The service writes, in one tenant transaction:

1. the locked appointment mutation;
2. status history;
3. canonical timeline and audit evidence;
4. durable outbox event.

Transient WebSocket emission remains post-commit UI behavior.

### 5.4 Unresolved visit work

A staff endpoint returns a typed, tenant/patient/appointment-scoped view:

- child resource and relationship;
- current completion state;
- blocking classification;
- exact named owner or accepted transfer;
- safe route token;
- whether visit completion is allowed and whether pathway closure is allowed.

The server re-evaluates this view during completion. The OP workspace renders it before the Complete button and refreshes it immediately before the mutation. Completion remains online-only and fail-closed in active mode.

## 6. Inpatient pathway

### 6.1 Source events

Generation 4 consumes transactional inpatient events:

- `admission.created`
- `admission.readmission_linked`
- `bed.assigned`
- `bed.transferred`
- `discharge.workflow_opened`
- `discharge.work_item_completed`
- `discharge.drugs_dispensed`
- `clinical_document.discharge_summary.signed`
- `discharge.pending_result_handoff_recorded`
- `discharge.completed`
- `post_discharge.contact_recorded`

Existing canonical event names are mirrored to `event_outbox` in the same domain transaction.

### 6.2 Definition

`inpatient_admission_to_recovery` v1:

1. observe a canonical accepted admission and exact named primary physician;
2. observe admission-to-discharge planning;
3. wait for existing readiness work;
4. require signed summary, formal medication reconciliation, pending-result handoffs, follow-up booking or audited exception, and existing billing/consult/medication gates;
5. observe discharge;
6. wait for a recorded post-discharge contact or accepted transfer when a signed policy requires it;
7. finalize or link the existing seven-day readmission as a new, related admission episode.

No contact window or escalation threshold is embedded. Until that owner policy is signed and registered, the contact stage is recordable and reconciliation-visible but cannot start a timer.

### 6.3 Canonical admission

The bed quick-admit endpoint no longer creates a clinically weaker parallel admission. It either delegates to the canonical admission service with the full required contract or only assigns a bed to an already accepted admission. Existing callers receive an explicit validation error rather than a partial admission.

OP-to-IP transfer is not represented as a covering-clinician reassignment. It uses a typed cross-pathway handoff and requires destination acceptance before ownership transfers. Migration 595 durably records the originating appointment on admission rather than clearing advice as the only surviving link.

### 6.4 D3 discharge behavior

In active mode:

- no pending result is allowed to disappear from the signed discharge summary;
- every pending item must have exact typed lineage and the current named primary physician;
- a pending item with complete handoff evidence is a warning, not a blocker;
- a pending item without exact lineage, named ownership, or signed-summary inclusion blocks discharge;
- when a result becomes available, a linked action is created for the discharge owner without replacing the diagnostic ordering-owner obligation;
- unresolved items resurface in the staff follow-up view and only safe status/next-step text reaches the patient.

Off mode preserves current behavior. Shadow mode computes the active result and records reconciliation discrepancies without changing discharge.

### 6.5 Other readiness corrections

Active mode additionally requires:

- a completed formal medication reconciliation and take-home list;
- a follow-up plan tied to this admission and scheduled appointment, or an audited explicit exception;
- readiness-query failures to fail closed;
- one consistent signed-summary identity for edit, sign, readiness, patient view, and PDF, implemented through a transactional adapter while legacy and structured stores coexist.

LAMA, death, legal exceptions, and break-glass behavior are not silently changed; any future change requires explicit clinical/governance approval.

## 7. Registries, reconciliation, and registration

S4 appends immutable versions:

- workflow runtime registry v4, retaining v1-v3 exactly;
- projector generation 4, retaining generation 1-3 membership exactly;
- reconciliation registry v5, upgrading only OP and Inpatient profiles to vertical-adapter version 2.

OP and Inpatient reconciliation add:

- source-event projection completeness;
- typed child/closure-reference validity;
- terminal visit/discharge closure evidence;
- unresolved work without exclusive owner evidence;
- pending-result named ownership and summary inclusion;
- OP-to-IP handoff acceptance;
- formal medication reconciliation and admission-scoped follow-up evidence;
- readmission linkage;
- projector/inbox debt.

Registration scripts are dry-run by default and require `--apply --acknowledge-owner-sign-off`, exact checksums, active same-tenant clinical/operational owners, an ADMIN/SUPER_ADMIN approver, and visibility-policy evidence. Registration activates no tenant mode.

## 8. Product boundary

### Staff

- OP Workspace gets a typed unresolved-work panel immediately before completion.
- Discharge Hub shows pending-result items, exact named physician, ownership/summary state, and why an item would block.
- Command Board reuses its task sheet and adds relationship, blocking state, and named owner.
- Terminal/accountability mutations remain online-only and are never added to the offline queue.

### Patient

- “What’s Next” receives only allowlisted next-step objects: safe label/explanation, optional due date supplied by an approved domain record, status, patient action, responsible clinician display name/role, safe contact, and route token.
- Signed discharge summaries may expose a patient-safe pending-result section.
- Raw task labels, internal blocker text, ownership-transfer evidence, staff comments, preliminary/unverified results, ward/IP notes, and workflow internals never cross the portal boundary.
- Existing signed/appointment-bound OP note visibility remains unchanged.

The universal cross-pathway patient card, full notification deep-link matrix, rollout UX, and full accessibility/localisation review remain S6.

## 9. Tests and acceptance

Required focused proof:

- migration 595 applies to an empty PostgreSQL database; Prisma schema and migration agree;
- resource references reject unknown types, missing/cross-tenant/wrong-patient rows, mutation, deletion, duplicate replay, and actor ambiguity;
- appointment transitions enforce tenant/source state and atomically produce history, canonical, and outbox evidence;
- projector generation 4 is replay-safe and older generations remain frozen;
- visit completion does not close OP while blocking/unowned child work remains;
- nonblocking OP work closes only after accepted named ownership;
- no-show and reschedule branches preserve durable recovery/replacement evidence;
- quick-admit cannot bypass canonical admission validation;
- discharge blocks on an unowned or undisclosed pending Lab/Radiology/AP item and permits a fully handed-off pending item;
- result availability creates a linked owner action without mutating the original diagnostic obligation;
- formal medication reconciliation and admission-scoped follow-up/exception are enforced only in active mode;
- patient serializers ignore injected internal fields and expose pending results only from signed artifacts;
- one OP journey, one admission-to-recovery journey, and one OP-to-IP handoff/lineage journey pass.

Generic executor atomicity, CAS, tenancy, replay, and concurrency remain covered once in the spine conformance suites.

## 10. Explicit non-goals

- no production `active` mode;
- no deploy;
- no backfill based on patient/time heuristics;
- no invented clinical timing, threshold, cadence, recipient, or break-glass policy;
- no second workflow, SLA, reminder, or notification engine;
- no change to Stroke/STEMI authority;
- no OBGyn-specific pathway definition;
- no universal patient workflow graph;
- no silent LAMA/death/exception policy change.
