# Unified Care Pathways S5 — ED Closure and Recovery Completion

**Date:** 2026-07-27

**Status:** implementation baseline
**Prerequisite:** S5 destination handoff on main at `4a013b4e2`

## 1. Outcome

Complete `emergency_arrival_to_aftercare` from arrival through every existing
terminal ED branch without creating a second admission, theatre, diagnostic,
death, mortuary, MLC, patient-merge, reminder, SLA, or escalation engine.

The existing ED visit remains the operational source of status and
disposition. The pathway adds exact, append-only closure evidence and recovery
evidence, then closes only when the selected branch's live domain records prove
responsibility transfer or safe aftercare.

## 2. Owner decisions and policy boundary

This slice implements the approved program decisions:

- Stroke and STEMI pathway/event authorities remain unchanged.
- The pathway rails are reusable by later OBGyn work; no OBGyn-specific engine
  is added here.
- Normal diagnostic closure, abnormal result review, referral acknowledgement,
  pending-results discharge, and mandatory surgical sign-in remain governed by
  their already approved domain decisions and separate verticals.

This slice intentionally does not choose:

- an ED recovery callback deadline or attempt count;
- an ED escalation interval or recipient;
- a patient notification channel;
- an external-provider communication transport;
- a new risk classification vocabulary;
- a break-glass rule, retention period, or production activation tenant.

Those values remain clinical/governance configuration gates. The schema stores
policy-neutral evidence and the runtime consumes only exact recorded facts.

## 3. Existing authorities retained

| Concern | Authoritative source |
| --- | --- |
| Arrival, triage, treatment, status, disposition | `emergency_visits` and ED services |
| Ward/ICU/HDU/surgery acceptance | `care_handoff_instances`, its exact role task, and `admissions` |
| External destination acceptance | the same accepted ED destination handoff |
| Diagnostic result action and patient release | diagnostic generations/actions/release states |
| Follow-up | `follow_up_plans` |
| Death certification | `death_records` |
| Mortuary custody | `body_custody_events` / `mortuary_slots` |
| Medico-legal completeness | `mlc_records` / `mlc_completeness_reviews` |
| Duplicate-patient resolution | `patient_merge_requests` |
| Stroke/STEMI clocks and events | the existing stroke/STEMI pathway tables |

## 4. New evidence

### 4.1 `ed_closure_evidence`

An append-only, revisioned clinician record linked to the exact tenant, visit,
patient, canonical encounter, and ED pathway source episode. Its human closure
task additionally binds the exact version-2 pathway instance.

Every revision records:

- closure kind: discharge, LAMA, LWBS, external transfer, or death;
- the named clinician;
- patient-safe next steps;
- medication-reconciliation completion or a clinician-authored
  not-applicable rationale;
- an exact follow-up plan when follow-up is required;
- branch-specific evidence;
- canonical timeline and audit records;
- a tenant-scoped idempotency key.

Branch-specific shape:

- **discharge:** patient-safe next steps, medication reconciliation, and exact
  follow-up decision;
- **LAMA/LWBS:** the discharge fields plus clinician-entered risk
  classification and risk summary;
- **external transfer:** exact accepted handoff, receiving-facility
  confirmation, clinical-summary transmission, and transport confirmation;
- **death:** exact death record and, when applicable, exact MLC record. The
  runtime independently verifies certification, MLC completeness, and mortuary
  custody from their live authorities.

Evidence is never edited or deleted during normal operation. A correction is a
new revision, preserving the prior clinical record.

### 4.2 `ed_recovery_contact_events`

Append-only manual attempt/outcome evidence for LAMA and LWBS recovery. It
records who acted, when, the channel, a policy-neutral outcome code, a
patient-safe summary, and staff-only notes.

No timer, attempt count, or automatic message is embedded. A recovery branch
closes only after at least one recorded attempt and an explicit clinician
outcome. This is an existence/attestation rule, not a clinical timing policy.

### 4.3 Existing identity and capacity evidence

No mutable identity ledger is added.

- A resolved temporary patient is proven by `users.is_unidentified = false`.
- A possible duplicate is proven by an exact `patient_merge_requests` record;
  the ED pathway never rewrites immutable encounter/pathway identities.
- An unresolved temporary identity can be explicitly retained with a
  clinician rationale in the closure revision, so urgent care is not blocked.

No second bed-allocation table is added.

- An accepted internal handoff transfers responsibility even when the existing
  admission records `bed_pending_since`.
- A declined destination handoff may carry the structured reason code
  `capacity_unavailable`; rerouting remains explicit.

## 5. Branch closure rules

| ED branch | Required proof |
| --- | --- |
| admitted ward/ICU/HDU/surgery | exact accepted destination handoff plus exact linked admission |
| external transfer | exact accepted external handoff plus finalized external-transfer closure evidence |
| discharged | finalized discharge closure evidence |
| LAMA | finalized LAMA closure evidence, contact attempt, and clinician recovery outcome |
| LWBS | finalized LWBS closure evidence, contact attempt, and clinician recovery outcome |
| expired | finalized death closure evidence, certified death record, applicable MLC completeness, and mortuary receive/release custody evidence |
| observation | remains a non-terminal ED state until another disposition is selected |

Unplanned LWBS or death status is never blocked merely because follow-up
evidence does not yet exist. The ED visit records the fact immediately while
the pathway remains active/on-hold and the named recovery/closure work remains
visible.

In active mode, planned discharge, LAMA, and external transfer transitions are
gated by the exact latest closure revision. Shadow mode records evidence and
reconciliation findings but does not block care.

## 6. Runtime and replay

The version-1 emergency definition and runtime registry generation remain
frozen for historical replay.

This slice adds:

- emergency definition version 2;
- workflow runtime registry version 6 with version-2 ED condition/action
  handler identifiers;
- pathway projector generation 6, retaining generations 1–5 unchanged;
- reconciliation registry version 7, retaining version 6 unchanged.

All ED visit, closure-evidence, and recovery-evidence outbox events converge on
the same projector. The projector reloads live branch evidence and executes the
version-pinned pathway. Generation-6 replay resolves an existing ED instance
before selecting a runtime, so a historical version-1 arrival remains on
registry V5 and is never reinterpreted as version 2. It does not trust event
payloads as clinical truth.

## 7. Task-first human work

Human-actionable ED work uses the live `tasks` engine without an invented SLA:

- the existing destination role-review task remains unchanged;
- closure review is assigned to the named ED clinician;
- LAMA/LWBS recovery work remains assigned until an explicit recovery outcome.

The task uses `due_at = NULL`, no SLA instance, and
`sla_completion_semantics = none` until governance supplies a registered rule.

## 8. Staff and patient surfaces

The staff ED workbench gains one continuity panel showing:

- branch evidence completeness;
- closure revision history;
- external-transfer evidence;
- LAMA/LWBS recovery attempts and outcome;
- death/MLC/mortuary source status;
- temporary-identity and bed-pending state.

The continuity detail read resolves the ED visit to its tenant-scoped patient
before the governed care-team access check. Evidence writes remain narrower:
only the exact viable named ED clinician may author them.

The patient portal exposes only released patient-safe ED next steps from the
latest applicable closure revision. It never exposes staff notes, MLC data,
death/mortuary records, risk narratives, internal tasks, placeholder
identities, handoff rejection reasons, or reconciliation details.

## 9. Activation

The migration does not activate the pathway for any tenant. Production
activation still requires:

- the approved version-2 definition and governance pin;
- projector and reconciliation clean-streak evidence;
- clinical/governance sign-off on any tenant-specific recovery timing,
  escalation, communication, visibility, break-glass, and retention policy.
