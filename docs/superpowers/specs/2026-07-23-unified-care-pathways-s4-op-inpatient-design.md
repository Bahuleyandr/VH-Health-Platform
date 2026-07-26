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
- append-only `discharge_pending_result_owner_actions`, one current leaf per
  result generation while retaining every predecessor owner action;
- append-only `post_discharge_contact_events` for manually or policy-triggered contact attempts/outcomes, with no default due time.

The initial primary physician is the explicitly valid same-tenant attending physician, falling back to the explicitly valid admitting physician only when no attending physician was recorded. Once a named physician is supplied, invalidity fails closed; it never silently degrades to a role queue.

Responsibility changes require an accepted, audited covering-clinician handoff. A pending-result handoff snapshots the exact source type/id, patient-safe label, current status, named physician, signed-summary inclusion evidence, linked task, and resolution/generation evidence. If a separately registered notification policy emits an intent, the handoff also snapshots that receipt. S4 registers no default notification policy: without one it invents no recipient, cadence, or receipt. The row is mutable operational truth; every transition also produces append-only pathway/canonical evidence.

Generic covering-clinician transfer from a live `wait` stage is governed by an
exact allowlist: Diagnostics and Inpatient only. `task` and `approval` remain
eligible human-ownership stages for every pathway. Referral and OP `wait`
stages cannot use this generic path because their receiver/current-owner and
appointment-doctor contracts remain authoritative.

For Inpatient, request, exact-recipient acceptance, and accepted-handoff
application to the admission attending are supported only while the pathway
and admission are live. Applying the accepted handoff appends the next
primary-physician assignment; it does not rewrite its predecessor.

The pending-result collector is tenant-scoped and typed across investigation/laboratory, radiology, and Anatomical Pathology sources. It never treats patient/time proximity as lineage. Sources that cannot prove admission membership become reconciliation findings and cannot satisfy the active-mode handoff gate.

The first result generation fills the handoff's immutable resolution anchor and
appends its named-owner action. A corrected direct-successor generation does
not rewrite that anchor: it terminates the superseded action task and appends a
new owner action/task for the corrected current leaf. Replays return the same
action, and an older or unrelated generation can never become current.

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
- `appointment.follow_up_recorded`
- `appointment.closure_evidence_recorded`
- `appointment.child_resource_linked`

The event identifies the resource. Registered handlers reload durable domain evidence and never trust a signal payload for clinical decisions.

Surgery advice remains deferred to S5. Generation 4 does not reserve an
`appointment.surgery_advised` event until an authoritative transactional
surgery-advice domain and producer exist.

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
- `admission.diagnostic_resource_linked`
- `bed.assigned`
- `bed.transferred`
- `discharge.workflow_opened`
- `discharge.work_item_completed`
- `discharge.drugs_dispensed`
- `clinical_document.discharge_summary.signed`
- `discharge.pending_result_handoff_recorded`
- `discharge.pending_result_available`
- `discharge.pending_result_resolved`
- `discharge.completed`
- `post_discharge.contact_recorded`

The established canonical timeline/audit event remains `discharge_summary.signed`.
The distinct pathway/outbox source event is
`clinical_document.discharge_summary.signed`. Both are written in the same
domain transaction; the pathway vocabulary does not rename the canonical
clinical event.

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

The named discharge physician may cross-sign the exact current different-owner
doctor disposition from either Clinical Inbox or the prior-admission pending
result card when the server returns `can_cross_sign: true`. Both surfaces show
the exact generation, snapshot hash, classification, and authoritative prior
doctor disposition; refresh that binding before submission; require explicit
attestation; and reuse one idempotency key while retrying the same binding.
Normal auto-close, same-owner settlement, resolved work, non-owner work, and
stale bindings remain read-only. A corrected generation re-arms a new exact
binding and therefore requires a new attestation and idempotency key.
A same-generation `doctor_reopened` action likewise appends a successor
owner-action and a new parent/child task pair; it never rewrites the completed
predecessor or its historical cross-sign receipt.

Final discharge rechecks ownership while holding the admission lock. The
inpatient pathway owner, current primary-physician assignment, and admission
attending must be the same physician. Assignment version 2 or later must also
prove the exact accepted covering handoff from the superseded assignment;
otherwise active readiness reports `INPATIENT_OWNER_ASSIGNMENT_DIVERGED`.

S4 does not define a new post-discharge transfer policy for outstanding result
ownership. Once an admission is terminal, a new generic transfer request or
acceptance fails with
`INPATIENT_POST_DISCHARGE_OWNER_TRANSFER_UNSUPPORTED` while any handoff remains
`pending` or `result_available`. Exact successful request and acceptance
replays remain idempotent. Historical owner actions remain immutable, and the
future governed post-discharge transfer/convergence policy is explicitly
deferred.

Off mode preserves current behavior. Shadow mode computes the active result and records reconciliation discrepancies without changing discharge.

### 6.5 Other readiness corrections

Active mode additionally requires:

- a completed formal medication reconciliation and take-home list;
- a follow-up plan tied to this admission and scheduled appointment, or an audited explicit exception;
- nonblank, clinician-signed typed sections for patient or guardian
  instructions, the escalation contact/service, required equipment or home
  care (including an explicit none-required record), discharge destination,
  and transport plan;
- readiness-query failures to fail closed;
- one consistent signed-summary identity for edit, sign, readiness, patient view, and PDF, implemented through a transactional adapter while legacy and structured stores coexist.

Migration 595 adds those five typed sections to templates and unsigned drafts
only for tenants already in `shadow` or `active`; `off` is untouched. New
drafts follow the same structural rule so shadow can report readiness before
activation. Signed and delivered summaries are never rewritten. The missing,
blank, or placeholder sections block sign-off and readiness only in `active`;
shadow remains observational. Active readiness evaluates the persisted section
identities so a legacy signed summary cannot silently bypass the contract.

`discharge_type=transfer` means an external-facility discharge, not the
existing internal ward/bed transfer endpoint. In `active` it returns
`EXTERNAL_TRANSFER_BRANCH_DEFERRED` until governed accepting-facility,
recipient-owner, transport, exception, and terminal-outcome evidence exists.
Off and shadow retain existing terminal behavior.

LAMA and death bypass ordinary planned-discharge readiness but remain open and
reconciliation-visible; they do not silently satisfy normal pathway closure or
post-discharge contact completion. Legal exceptions and break-glass behavior
are not silently changed; any future change requires explicit
clinical/governance approval.

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

- “What’s Next” continues to expose live goals and follow-up plans. Immutable OP closure next-step snapshots stay staff-side and the `next_steps` array remains empty until every exposed step type has an exact live domain source reference and a current-actionability/satisfaction rule; completed, cancelled, or otherwise satisfied source work must never remain as a patient action.
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
- Diagnostics and Inpatient accept exact-recipient generic coverage from live
  wait stages, while Referral and OP wait stages reject that bypass;
- active discharge rejects pathway-owner, admission-attending, primary-assignment,
  or accepted-handoff divergence under the final admission lock;
- terminal admissions with live pending-result ownership reject new generic
  transfer requests and acceptances while preserving exact successful replays;
- formal medication reconciliation and admission-scoped follow-up/exception are enforced only in active mode;
- each missing signed instruction, escalation, equipment/home-care,
  destination, or transport record independently blocks active discharge;
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
- no task-backed named child-ownership acceptance writer. The typed reference
  substrate only accepts an exact task with `status = 'completed'` and a
  non-null completion timestamp; S4 projectors write open/completed child
  references, while the typed accepted-transfer closure remains the only
  implemented direct ownership path.
- no terminal-admission owner-transfer policy. After terminal discharge with
  live `pending` or `result_available` handoffs, new generic transfer requests
  and acceptances fail closed while exact successful replays remain safe,
  until clinical/governance owners sign a terminal transfer/convergence
  contract.
- no S4 implementation claim for OP teleconsult-failure recovery, emergency
  escalation, follow-up-overdue/lost recovery, chronic-care transfer, or
  surgery-advice branches. They remain required by the parent program and are
  staged behind explicit clinical owner and governance decisions; S4 invents
  no event, routing, timing, escalation, or transfer policy for them.
- no active S4 decision branch for ICU escalation or step-down, surgery or
  theatre transfer, external-facility transfer, TPA/insurance delay, or
  deterioration escalation. Existing domain workflows remain authoritative
  and any observed evidence stays reconciliation-visible. Each branch remains
  fail-closed/deferred until its clinical owner signs the exact entry
  criteria, accepting service/recipient, task ownership, transfer evidence,
  timing rules (if any), exception path, and terminal outcome contract.
