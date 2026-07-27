# Unified Care Pathways S5 — ED Destination Handoff Design

**Status:** Owner-approved ED destination-acceptance loop implemented behind `off|shadow|active`; no production activation in this slice

**Baseline:** `github/main` `e008574f6dacb1577761d81499a8549b1f60da84` (2026-07-26T22:27:11+05:30)

**Branch:** `feat/care-pathways-s5-ed-handoff`

**Migration:** `596` (next free after `595_care_pathways_op_inpatient.sql`)
**Parent design:** `docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md`

## 1. Outcome and boundary

This slice closes the previously unacknowledged ED-to-destination transfer:

1. an identified ED patient has one named attending doctor;
2. the visit reaches `awaiting_disposition`;
3. that doctor requests ward, ICU, HDU, surgery, or external-transfer acceptance from an explicit current staff role;
4. one task appears in that role's ED queue;
5. a current active holder of the exact database role accepts or declines;
6. a decline requires a reason and the same sender may reroute it;
7. admission or external transfer requires the exact accepted handoff; and
8. the ED pathway closes only when the receiving destination or an existing non-receiver terminal outcome is durable.

The task has high operational priority but no due time, SLA instance, escalation rule, business-hours rule, or notification recipient. None was clinically approved, so none is inferred.

This is the destination-acceptance core, not a claim that every parent-program ED branch is complete. It does not add policy-defined discharge aftercare, callback timing, unidentified-patient conversion, destination-bed allocation, receiving-facility confirmation, transport confirmation, or LAMA/LWBS recovery outreach. Those remain separate governed slices.

## 2. Existing authority retained

- `emergency_visits` remains the ED visit and disposition authority.
- Canonical timeline/audit rows and the event outbox remain the source-event evidence.
- The unified pathway spine owns runtime, transitions, handoffs, tasks, governance pins, projection, and reconciliation.
- The canonical admission service remains the only active-mode ED-to-inpatient closure path.
- Existing Stroke and STEMI pathway-event tables and clocks remain authoritative and unchanged.
- The surgical sign-in gate delivered immediately before this slice remains authoritative; an ED-to-surgery handoff does not replace it.
- OBGyn remains rails-first and receives no separate handoff, task, SLA, reminder, or notification engine.

## 3. Mode behavior

| Mode | ED behavior | Pathway evidence | Destination task and gate |
|---|---|---|---|
| `off` | Existing ED writes and dispositions remain unchanged | None from this slice | None |
| `shadow` | Existing ED writes plus canonical/outbox source evidence | Hidden runtime and reconciliation evidence | No handoff mutation; no terminal enforcement |
| `active` | Same source writes | Evidence-gated V5 runtime | Named sender, exact role task/decision, and accepted-handoff terminal gate |

Creating a shadow or active ED source also materializes its exact `patient_encounters` row in the same tenant transaction. The ED visit's UUID `encounter_id` is reused as the canonical encounter ID. The projector repeats this as an idempotent repair for older source events, so historical shadow projection does not fail merely because pre-S5 ED rows lacked a `patient_encounters` record.

`tasks.encounter_id` is a legacy integer and cannot store the ED UUID. The ED handoff task therefore keeps that column null and records the exact canonical UUID in immutable task metadata as `canonical_encounter_id`. The service, admission gate, runtime handler, reconciliation checks, and deferred database constraints all verify that contract.

## 4. Runtime and source events

`emergency_arrival_to_aftercare` v1 runs on workflow registry V5:

1. `observe_arrival_and_owner`
2. `observe_disposition_readiness`
3. `await_destination_acceptance`
4. `observe_destination_or_closure`
5. `finalize_emergency_pathway`

Projector generation 5 adds:

- `emergency.visit.created`
- `emergency.visit.transitioned`
- `emergency.visit.destination_closed`

The projector reloads durable visit, patient, encounter, owner, handoff, task, accepter, and admission evidence. Event payloads identify the source but never decide clinical completion.

Direct active-mode `admitted` transitions are rejected; admission must use the canonical admission workflow. Active `transferred` transitions require `accepted_handoff_id`. Admission locks the ER visit, rechecks that it is still open, validates the exact accepted role handoff and completed task, creates the admission with `source_pathway_instance_id` and `source_handoff_id`, closes the ED visit, and emits destination-closure evidence in one transaction.

## 5. Handoff and authorization contract

`care_handoff_instances.handoff_type = 'ed_destination_handoff'` is constrained to:

- one named user sender who is the visit's current attending doctor;
- source stage `await_destination_acceptance`;
- source resource `emergency_visit`;
- role recipient only;
- destination `ward|icu|hdu|surgery|external_transfer`;
- no recipient user/team/external reference;
- no due time or urgency policy;
- one exact task and request fingerprint; and
- requested, accepted, declined, or rerouted lineage states only.

The authenticated actor is reloaded and locked before authorization. A request requires the current named ED owner, and the intended role must be one of the roles authorized to open the ED destination queue so a typo cannot create an unreachable live handoff. This is a technical reachability guard, not a destination-to-role clinical mapping. A decision requires an active user whose current raw database role exactly equals the handoff's intended role. A decline requires a bounded non-control-character reason. Only the unchanged sender may reroute a declined handoff. Request, decision, and reroute operations use actor-namespaced idempotency fingerprints and compare-and-set transitions.

The API returns bounded handoff/task/source identifiers. Patient UID is attached only as a non-enumerable server-side PHI logging context and is not serialized in the mutation response.

## 6. Migration and admission lineage

Migration 596:

- extends the closed task-kind constraint with `ed_destination_handoff_review`;
- expands admission source lineage from the OP-only shape to exactly one of:
  - OP: `source_appointment_id` plus pathway/handoff, with no ER source; or
  - ED: `from_er_visit_id` plus pathway/handoff, with no OP source;
- rejects partial or mixed OP/ED pathway lineage;
- adds the ED handoff shape and fingerprint constraint;
- adds one-live-handoff and one-reserved-task indexes;
- validates handoff/task/pathway/visit/owner binding with deferred constraint triggers;
- validates accepted decisions against the exact current active role; and
- rejects active admitted/transferred ED terminal rows without an exact accepted handoff, including admission source linkage for admitted visits.

No migration row activates a definition, tenant mode, SLA, notification, reminder, or clinical threshold.

## 7. Interfaces

Staff API:

- `POST /api/v1/ed/visits/:id/destination-handoffs`
- `GET /api/v1/ed/destination-handoffs`
- `POST /api/v1/ed/visits/:id/destination-handoffs/:handoffId/decisions`
- `POST /api/v1/ed/visits/:id/destination-handoffs/:handoffId/reroute`

The existing ED transition operation accepts `accepted_handoff_id` for an active external-transfer closure. The existing admission operation accepts the already-standard `source_pathway_instance_id` and `source_handoff_id` alongside `from_er_visit_id`.

The staff ED Trauma workbench adds:

- a visit/destination/role/reason request form;
- the actor's sender/receiver queue;
- accept, decline-with-reason, and reroute actions;
- safe localized success/error copy; and
- English, Hindi, Tamil, and Telugu entries required by the staff localization gate.

The OpenAPI source, backend generated document, and shared core copy describe the same operations and schemas.

## 8. Reconciliation and rollout

Reconciliation registry V6 adds:

- `emergency_source_projection`
- `emergency_destination_handoff_evidence`

They verify source projection, active-mode terminal coverage, exact task/handoff/encounter binding, accepted-role viability, and admission lineage. Frozen V1-V5 registries and checksums remain unchanged.

Definition registration is dry-run by default:

```text
npm run care-pathways:register-emergency-definition
```

Applying registration still requires the shared script's explicit owner-sign-off acknowledgement, approved same-tenant owners, approver, visibility-policy evidence, and exact checksum. Registration does not change tenant mode.

Safe rollout remains:

1. deploy migration and code while the pathway is `off`;
2. register the governed definition;
3. switch only the chosen tenant to `shadow`;
4. drain/replay projection and run V6 reconciliation;
5. investigate every source, encounter, handoff, role, and terminal discrepancy;
6. require the normal clean evidence streak; and
7. perform a separate authorized active-mode ceremony.

Rollback is a tenant mode change to `off`; immutable runtime, handoff, transition, canonical, outbox, and reconciliation evidence is retained.

## 9. Acceptance proof

The focused acceptance set covers:

- migration shape and database enforcement;
- frozen registry generations and exact checksums;
- off-mode no-op behavior;
- shadow/active canonical ER encounter materialization;
- event identity, projector replay, and V5 runtime progression;
- named-owner request authorization;
- exact current-role decision authorization;
- request/decision replay, stale-state compare-and-set, decline reason, and reroute lineage;
- task binding with null legacy encounter, exact canonical UUID metadata, and no SLA;
- admission rejection without source linkage;
- admission rejection for wrong pathway/handoff/patient/visit/role/task binding;
- concurrent ER close-state recheck under row lock;
- real API journey from ED creation through role acceptance and exact linked admission;
- final ED visit, admission, runtime, and pathway closure evidence;
- staff request/accept behavior and safe error copy;
- staff localization and analyzer gates; and
- generated OpenAPI parity.

## 10. Explicit non-goals

- no production active-mode flip or deploy;
- no invented SLA, escalation recipient, notification policy, or clinical timing;
- no second workflow, handoff, task, reminder, or event engine;
- no replacement of Stroke/STEMI clocks;
- no replacement of the surgical sign-in gate;
- no patient-facing workflow graph or new patient notification;
- no patient/time-proximity inference or bulk clinical backfill;
- no destination bed, facility, transport, aftercare, LAMA/LWBS recovery, unidentified-patient, or break-glass policy;
- no claim that the remaining ED parent-program branches are complete.
