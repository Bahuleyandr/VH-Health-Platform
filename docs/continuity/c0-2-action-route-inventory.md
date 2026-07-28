# C0.2 Clinical Action and Route Inventory

**Status:** evidence draft — recommendations are not clinical approval

**Repository baseline:** `d52daac2c60eb921b327c80c886f35f6e603b528`

**Baseline commit time:** `2026-07-28T13:56:41+05:30`

**Authority:** [implementation plan C0.2](../superpowers/plans/2026-07-28-clinical-service-continuity.md#c02-clinical-action-and-route-inventory), [design §3 and §5.4](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md), [canonical clinical timeline](../CANONICAL_CLINICAL_TIMELINE.md), and [current ward downtime procedure](../DOWNTIME_PROCEDURE.md)

## 1. Scope, method, and proof bar

This inventory re-derives the production Staff enqueue census from the pinned
repository baseline. It does not cover C0.1 live-state capture and does not
approve an offline action.

The production Dart search found exactly eight enqueue expressions:

- seven direct `ConnectivitySyncService.instance.enqueue(...)` calls; and
- one `_sync.enqueue(...)` call inside `NoteDraftAutosave`, bound in production
  by `NoteDraftSync.live` to the same connectivity service.

`OfflineQueue.enqueue(...)` has one production caller, the connectivity-service
adapter. The Patient `MutationQueue.enqueueOrExecute(...)` method has no
executable production caller. Every Staff expression is classified below:
**zero queue call sites remain unclassified in this dossier**.

All Staff rows use the same transport envelope. Enqueue persists an encrypted,
Staff-owner-scoped SQLite row and a stable client idempotency key
(`packages/vhhealth_core/lib/services/offline_queue.dart:199-227`).
Drain replays stored `POST`, `PUT`, or `PATCH` requests under the current
matching Staff session; success deletes the row, definitive client/conflict
responses mark a conflict, and other failures retry
(`packages/vhhealth_core/lib/services/connectivity_sync_service.dart:118-134,189-294`).
That transport behavior does not make a route clinically safe or idempotent.

## 2. Complete Staff enqueue inventory

| # | Enqueue site; endpoint and method | Repository domain owner; meaning | Patient and encounter identity | Occurrence-time support | Idempotency middleware | Optimistic concurrency | Actor authorization at replay | Canonical timeline and audit | SLA and outbox | Current replay result | Declared-policy and procedure comparison |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart:1014-1082`<br>`POST /api/v1/prescriptions/create` (`apps/staff/lib/features/doctor/prescription_offline_rx.dart:34-70`; `apps/backend/src/routes/prescription/index.js:32-47`) | OP prescribing; named accountable owner is not encoded. Replay creates a durable, initially unsigned prescription and follow-up effects, not a device-local draft (`apps/backend/src/controllers/prescription/ePrescriptionController.js:1194-1478`). | Body carries patient, named doctor, optional appointment, diagnosis, notes, medications, and vitals; it omits admission, source revision, facility, incident, and paper identity (`apps/staff/lib/core/services/prescription_payloads.dart:12-37`). Encounter linkage is only ensured when an appointment exists (`ePrescriptionController.js:1310-1322`). | No capture/occurrence field. Detail and canonical occurrence use replay-time database time (`apps/backend/src/services/clinical/canonicalClinicalPlatformService.js:433-480`). | **Optional/fail-open.** The route accepts the queue key but can execute without a usable receipt (`apps/backend/src/routes/prescription/index.js:32-47`; `apps/backend/src/middleware/idempotencyMiddleware.js:43-76`). | None. Appointment duplicate checking is not a compare-and-swap condition (`ePrescriptionController.js:1051-1077`). | Current JWT, device posture, RBAC, and patient-access policy are re-evaluated; queue ownership limits drain to the current Staff owner. Named `doctor_id` may differ from the replay actor, while `created_by` and canonical actor use the current user (`ePrescriptionController.js:1088-1089,1316,1345-1346`). | Prescription, medication-safety findings, and `prescription.created` timeline/audit evidence are transactional (`ePrescriptionController.js:1194-1421`). | No workflow-SLA instance. Appointment-linked work may publish a child-resource outbox event. Notification dispatch is post-commit and has no durable dispatch intent or delivery guarantee; a successful in-app branch persists a notification row (`ePrescriptionController.js:1364-1478`; `apps/backend/src/utils/notifications/notificationDispatcher.js:102-113`). | A success deletes the row and leaves a server prescription. Definitive validation/CDS responses become conflicts. Optional receipt failure or a later re-execution can duplicate the effect. | Direct contradiction: policy says `op_prescription_draft` is `local_draft_only`; the UI never calls the exposed policy getter and instead auto-replays the production create route (`canonicalClinicalPlatformService.js:110-152`; `apps/staff/lib/core/services/clinical_platform_api_service.dart:123-132`). The current procedure sends ward orders to paper but explicitly does not package OPD, so it supplies no OPD action procedure (`docs/DOWNTIME_PROCEDURE.md:27-38,62-67`). |
| 2 | `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart:147-218`<br>`POST /api/v1/emr/orders` (`apps/staff/lib/features/ipd/drug_chart_offline_order.dart:34-95`; `apps/backend/src/routes/emr/orderRoutes.js:154-205`) | Inpatient CPOE/drug chart; named accountable owner is not encoded. Replay creates an `ordered` medication order and can start MAR and ward-indent work, not a retained draft (`apps/backend/src/services/emr/orderEntryService.js:590-661,673-788,1048-1075`). | Body carries patient UID, optional encounter, medication/order details, priority, and start date; it omits admission identity/state, source revision, facility, incident, and paper identity (`apps/staff/lib/core/services/order_payloads.dart:8-69`). The service does not establish that the optional encounter belongs to the patient (`orderEntryService.js:473-572`). | A capture-time treatment `start_date` is present and drives downstream MAR scheduling, but no distinct command-occurrence field is preserved; order creation and canonical occurrence use replay time (`apps/staff/lib/features/ipd/screens/drug_chart_screen.dart:200`; `apps/staff/lib/core/services/order_payloads.dart:35-46`; `apps/backend/src/services/emr/orderEntryService.js:394-462,721-768,1048-1075`). | **Required/fail-closed.** The route requires an idempotency key and rejects unavailable receipt storage (`apps/backend/src/routes/emr/orderRoutes.js:154-159`; `apps/backend/src/middleware/idempotencyMiddleware.js:69-75,98-105`). | None. There is no admission-state/source revision condition or semantic medication-order deduplication. | Current matching queue owner, JWT, doctor role, device posture, and patient access are re-evaluated. `ordered_by` is the current replay actor (`orderRoutes.js:173-189`). | Order, medication-safety findings, and `order.created` timeline/audit evidence are transactional (`orderEntryService.js:721-768`). | No canonical workflow-SLA instance. A legacy first-drug-chart measurement and MAR/indent effects run after create; routine inpatient orders do not publish the appointment child-resource outbox event (`orderEntryService.js:590-661,1048-1075`). | A success deletes the row after creating the operational order and attempting downstream effects. Validation/access/conflict responses become conflicts; server failures retry. | Direct contradiction: `ip_drug_chart_draft` is `local_draft_only`, while this path auto-replays the production order endpoint (`canonicalClinicalPlatformService.js:130-134`). The ward procedure sends new orders to paper (`docs/DOWNTIME_PROCEDURE.md:27-46`). |
| 3 | `apps/staff/lib/features/nursing/screens/mar_scan_screen.dart:184-231`<br>`POST /api/v1/clinical/mar/:id/administer-with-scan` (`apps/staff/lib/features/nursing/mar_offline_administer.dart:20-49`; `apps/backend/src/routes/clinical/clinicalRoutes.js:343-376`) | MAR/bedside nursing and medication safety; named accountable owner is not encoded. This changes an existing MAR row to an administered physical dose. | Path binds the MAR administration row; body carries scanned patient, drug barcode, administered time, and optional override reason. It does not bind encounter, admission, facility, incident, or source revision (`mar_offline_administer.dart:20-49`). | **Supported in the body:** bounded bedside `administered_at` is validated and stored. The canonical helpers are not given that value, so canonical occurrence remains replay time (`apps/backend/src/services/clinical/marFiveRightsService.js:47-73,184-197,258-339`). This is the only Staff queued body with a true clinical occurrence time. | **Absent.** The route does not mount the imported middleware, so the stable queue key is ignored (`clinicalRoutes.js:343-376`). | Status is checked before the transaction, but the update has no status/version predicate or locked read (`marFiveRightsService.js:42-73,258-286`). | Current clinical/nursing RBAC, MAR resource ReBAC, patient access, and matching queue owner apply. Device-posture middleware is absent on this route. `administered_by` is the replay actor rather than a preserved capture actor (`clinicalRoutes.js:61-99,350-369`). | Detail, timeline, and clinical audit are transactional, but the canonical event omits encounter and uses replay-time occurrence (`marFiveRightsService.js:258-342`). | No workflow-SLA or outbox write. | A first valid drain can administer the row. A lost-response redrain normally conflicts with the now-administered status; concurrent first attempts can both pass the preflight. | Plain MAR has no policy entry and is an unclassified authoritative capture. A row carrying an override reason intersects `blocked_offline` `medication_safety_override`. The ward procedure requires paper administration and governed back-entry (`docs/DOWNTIME_PROCEDURE.md:27-46`). |
| 4 | `apps/staff/lib/features/investigations/screens/specimen_scan_screen.dart:65-106`<br>`POST /api/v1/lab/samples/:investigationId/collect` (`apps/staff/lib/features/investigations/specimen_scan_intent.dart:19-56`; `apps/backend/src/routes/lab/labRoutes.js:147-161`) | Laboratory/investigations; named accountable owner is not encoded. This authoritatively records physical collection, stamps the collector/barcode, and can clear rejection state (`apps/backend/src/services/investigation/investigationService.js:1281-1309`). | Path binds investigation; body carries scanned patient UID and tube barcode. Backend resolves the investigation patient and rejects mismatch. Encounter, facility, incident, and source revision are absent (`investigationService.js:1240-1267`). | None. Backend collection and canonical occurrence use replay time (`investigationService.js:1281-1334`). | **Absent.** The route imports but does not mount the middleware (`labRoutes.js:20,147-161`). | None. Preflight is outside the transaction and the update predicates only ID and tenant, not expected status/revision (`investigationService.js:1237-1249,1278-1309`). | Current JWT, tenant, LAB/Staff role, patient access, and matching queue owner apply. Replay attributes the current actor rather than a capture-time role snapshot (`apps/backend/src/app.js:694-702,1349-1352`). | Detail update and timeline/audit pair share one tenant transaction; encounter is omitted (`investigationService.js:1278-1334`). | No workflow-SLA, task, notification, or outbox write. | A valid drain marks the investigation collected and deletes the queue row. A late replay can overwrite a rejection; an exact redrain is not protected by route idempotency. | No declared policy entry: an unclassified authoritative capture, not a literal policy-text conflict. Canonical guidance recommends paper/back-entry for physical work, but the current ward-only procedure is silent on specimen collection and supplies no Laboratory procedure (`docs/CANONICAL_CLINICAL_TIMELINE.md:226-237`; `docs/DOWNTIME_PROCEDURE.md:27-49,62-67`). |
| 5 | `apps/staff/lib/features/bloodbank/screens/transfusion_scan_screen.dart:69-112`<br>`POST /api/v1/blood-bank/:id/verify-bedside` (`apps/staff/lib/features/bloodbank/transfusion_scan_intent.dart:19-61`; `apps/backend/src/routes/bloodbank/bloodBankRoutes.js:372-386`) | Blood Bank/transfusion safety with bedside nursing participation; named accountable owner is not encoded. This persists authoritative verifier evidence used before transfusion. | Path binds request; body carries scanned patient/unit and client-selected first/second verifier role. Server resolves request patient, encounter, and pinned unit. Facility, incident, and source revision are absent; patient expectation may be omitted by the calling screen (`apps/staff/lib/features/bloodbank/screens/blood_bank_screen.dart:690-700`; `apps/backend/src/services/bloodbank/transfusionSafetyService.js:240-284`). | None. Verification time and state validation occur at replay time (`transfusionSafetyService.js:280-285,336-355`). | **Absent.** The route does not mount idempotency middleware (`bloodBankRoutes.js:372-386`). | Current-state checks exist, but there is no locked read, version, or compare-and-swap update. An upsert on request and verifier role can overwrite earlier verifier evidence (`transfusionSafetyService.js:248-278,336-355`). | Current JWT, broad blood-bank role policy, patient access, and matching queue owner apply. Actor UID comes from the replay session; verifier order is client-supplied, with server checks for distinct verifiers (`transfusionSafetyService.js:243-277`). | Verification and timeline/audit are transactional. Retry event keys are not stable command identities, so repeat execution can append new canonical evidence while overwriting the verifier row (`transfusionSafetyService.js:80-102,336-369`). | No workflow-SLA or durable outbox. A best-effort post-commit WebSocket board event is emitted (`bloodBankRoutes.js:381`). | A valid drain writes verifier evidence and deletes the row. State/scan/order failures become conflicts. Cross-device first/second queue order is not represented, and repeat execution can overwrite witness evidence. | No declared policy entry: an unclassified authoritative capture. The design recommends transfusion verification as paper-only backfill, while the current ward-only procedure is silent on transfusion and supplies no Blood Bank procedure (`docs/DOWNTIME_PROCEDURE.md:27-49,62-67`). |
| 6 | `apps/staff/lib/features/nursing/screens/nursing_notes_screen.dart:373-420`<br>`POST /api/v1/emr/notes` (`apps/backend/src/routes/emr/clinicalNotesRoutes.js:112-156`) | Nursing documentation; no category-specific accountable owner is encoded. One UI action covers nine materially different note categories but creates an unsigned authoritative `clinical_notes` row, not a private draft. | Body carries optional patient UID, required UI phone, raw category, text, and priority. It omits encounter, admission, appointment, facility, incident, capture session, and actor snapshot (`nursing_notes_screen.dart:377-397`). When UID is absent, the server uses a phone-based patient lookup (`clinicalNotesRoutes.js:50-67`). | None. Note and canonical occurrence use replay time (`apps/backend/src/services/emr/clinicalNotesService.js:384-430`). | **Optional/fail-open.** The route accepts a stable queue key but may execute without a usable receipt (`clinicalNotesRoutes.js:112-156`; `apps/backend/src/middleware/idempotencyMiddleware.js:43-76`). | None. No source/encounter revision or append precondition is supplied. | Current JWT, clinical role, patient write/relationship guards, desktop/tablet posture, and matching queue owner apply (`apps/backend/src/app.js:1103-1137`; `clinicalNotesRoutes.js:18-31,116-139`). | `clinical_notes`, `note.created` timeline, and clinical audit are transactional. All categories become subtype `nursing_assessment`; raw category survives only in content (`clinicalNotesRoutes.js:38-48,70-95`; `clinicalNotesService.js:384-430`). | No workflow-SLA, outbox, notification, or pathway-specific effect. | A success creates canonical note truth and deletes the row. Definitive responses become conflicts. Optional receipt failure or later re-execution can create a duplicate note. | Direct contradiction: policy permits note drafts, not authoritative offline note creates. Every current category must remain default-denied until its departmental owner approves a distinct action contract. The ward-only procedure is silent on clinical-note drafts/creates and supplies no documentation recovery rule (`docs/DOWNTIME_PROCEDURE.md:27-51,62-67`). |
| 7 | `apps/staff/lib/features/nursing/screens/vitals_screen.dart:179-251`<br>`POST /api/v1/health/records` (`apps/backend/src/routes/health/protectedRoutes.js:57-67`) | Nursing/vitals; named accountable owner is not encoded. This inserts an authoritative `patient_vitals` row, not a draft. | Staff sends integer patient ID only. The handler accepts optional admission/encounter fields, but this UI omits them; no facility, incident, source revision, or durable actor field is supplied (`vitals_screen.dart:215-235`; `apps/backend/src/controllers/health/patientHealthController.js:289-340`). | None. The insert uses server/database record time at replay (`patientHealthController.js:383-398`). | **Optional/fail-open.** A stable key is normally supplied, but receipt unavailability can execute the request (`protectedRoutes.js:57-67`; `apps/backend/src/middleware/idempotencyMiddleware.js:43-76,97-107`). | None; this is an unconditional append with no source revision. | Current API/JWT/tenant/RBAC applies. Patient users are self-limited, but the clinical path has no care-team/admission relationship check here. UI `recorded_by` is ignored and the row has no actor column (`patientHealthController.js:289-340`; `apps/backend/prisma/schema.prisma:7459-7477`). | No canonical timeline or `clinical_audit_events`; only post-insert HIPAA logging (`patientHealthController.js:383-440`). | No workflow-SLA, anomaly alert, or outbox write. | A successful drain inserts a vital and deletes the row. With a missing/unusable receipt or later re-execution, another vital can be inserted. | Policy names `vitals_draft`, but the current path creates authoritative server-time vitals and violates the canonical invariant; the ward procedure says vitals use paper/back-entry (`docs/DOWNTIME_PROCEDURE.md:27-46`). The design records this deficiency, but the program-specified C0A six-family scope does not currently name vitals. |
| 8 | `apps/staff/lib/features/emr/note_draft_autosave.dart:415-441`<br>`PUT /api/v1/emr/notes/draft` (`note_draft_autosave.dart:518-521`; `apps/backend/src/routes/emr/clinicalNotesRoutes.js:196-228`) | Private note-draft storage used by nursing and OP consultation. It is deliberately non-authoritative and scoped to the current author (`apps/backend/src/services/emr/clinicalNoteDraftService.js:1-12,78-131`). | Tenant and author come from the replay session; body carries patient UID, optional appointment, note type, and content. No facility, incident, encounter revision, or policy version is stored. | No clinical occurrence field; server update time is storage time. | **Absent.** The client sends a key, but the route does not mount the middleware. | None. Context-keyed upsert is last-write-wins, so a delayed older PUT can overwrite a newer draft (`clinicalNoteDraftService.js:78-131`). | Current clinical role, patient-write relationship, desktop/tablet posture, author JWT, and matching queue owner apply (`clinicalNotesRoutes.js:196-228`). | Correctly writes no canonical timeline or clinical audit because it is a private scratchpad (`clinicalNoteDraftService.js:1-12`). | None, correctly. | FIFO PUTs overwrite the same logical draft; success deletes the queue row and definitive responses become conflicts. Offline discard does not enqueue deletion of an already stored server draft (`note_draft_autosave.dart:292-348`). | Semantically matches declared nursing/OP draft classes, but no backend action registry enforces that classification and stale-write, facility/encounter, receipt, and replay-audit contracts are absent. It must never promote or advance clinical workflow. The ward-only procedure is silent on private note-draft storage (`docs/DOWNTIME_PROCEDURE.md:27-51,62-67`). |

## 3. Authoritative nursing-note objects

The single row 6 expression exposes nine UI categories
(`apps/staff/lib/features/nursing/screens/nursing_notes_screen.dart:303-345`).
The backend currently folds all nine into one `nursing_assessment` subtype
(`apps/backend/src/routes/emr/clinicalNotesRoutes.js:38-48,70-95`). That
implementation shortcut does not make them one clinical object for C0.2.

| Current UI category | Repository-derivable meaning or distinct structured domain | Required registry decision |
|---|---|---|
| Observation | General nursing observation; current body has no encounter or occurrence time. | Default-deny the current authoritative POST. OWNER INPUT must classify a distinct unsigned-documentation action. |
| Medication Note | Free text can be commentary about medication or can assert a medication-related action; the route does not distinguish them. | Default-deny the current authoritative POST. OWNER INPUT must separate narrative documentation from medication action. |
| Post-Procedure | Free text can document a performed procedure but carries no procedure identity or occurrence time. | Default-deny the current authoritative POST. OWNER INPUT must bind it to the responsible procedural domain. |
| Intake/Output | A structured I/O route exists separately and requires typed quantity/category data (`apps/backend/src/routes/emr/vitalsRoutes.js:230-270`). The note category bypasses that object. | Default-deny the current authoritative POST. OWNER INPUT must choose the structured action and its offline class. |
| Patient Complaint | Patient-reported concern recorded as free text without encounter or occurrence time. | Default-deny the current authoritative POST. OWNER INPUT must approve its documentation and escalation contract. |
| Wound Care | Free text can assert completed physical care without a wound/procedure identity or occurrence time. | Default-deny the current authoritative POST. OWNER INPUT must classify documentation separately from performed care. |
| Shift Handover | A structured handover object exists separately with outgoing/incoming nurse and acknowledgement semantics (`apps/backend/src/routes/clinical/clinicalRoutes.js:479-528`). The note category bypasses it. | Default-deny the current authoritative POST. OWNER INPUT must choose the structured handover action and acceptance rules. |
| Emergency Note | Free text can describe emergency care but carries no ED visit, incident, intervention, or occurrence identity. | Default-deny the current authoritative POST. OWNER INPUT must bind it to an approved emergency-documentation action. |
| Other | Unbounded free text has no safe action meaning or accountable domain. | Unknown action fails closed until OWNER INPUT recategorizes it. |

## 4. Note-draft production bindings

The row 8 autosave helper is attached to two production contexts, not two
additional enqueue expressions:

| Context | Identity and note type | Evidence | Proposed registry treatment |
|---|---|---|---|
| Nursing assessment draft | Current tenant and author, patient UID, no appointment, `nursing_assessment`; all nine UI category drafts share one logical draft. | `apps/staff/lib/features/nursing/screens/nursing_notes_screen.dart:212-230`; `apps/staff/lib/features/emr/note_draft_autosave.dart:139-181` | Private draft storage only; default-deny until the draft contract and backend registry are enforced. It can never become authoritative through replay. |
| OP consultation draft | Current tenant and author, patient UID, optional appointment, `op_consultation`. | `apps/staff/lib/features/opd/screens/op_doctor_workspace_screen.dart:140-203`; `apps/backend/src/services/emr/clinicalNoteDraftService.js:78-131` | Private `queueable_capture` draft storage only after the route contract is enforced; online finalization remains a fresh authorized action. |

## 5. Auxiliary and dormant surfaces

These surfaces are not additional active Staff enqueue sites, but C0.2 must
dispose of them explicitly.

| Surface | Current status and entry point | Identity, time, authorization, and effects | Offline/replay result | Proposed disposition |
|---|---|---|---|---|
| Patient `MutationQueue` | Dormant producer: `enqueueOrExecute` has zero executable production callers (`apps/patient/lib/core/offline/mutation_queue.dart:19-65`). `replayQueue` is subscribed to later online transitions in `apps/patient/lib/main.dart:183-194`. | A stored mutation carries method, endpoint, body, timestamp, and idempotency key, but the queue has no typed clinical action, actor/tenant/facility envelope, conflict state, or registry binding (`mutation_queue.dart:19-65,121-142`). | There is no shipped producer. Only a pre-existing stored row could replay; successes are removed and failures retained. An already-online startup does not itself emit the transition that invokes replay (`mutation_queue.dart:73-113`; `packages/vhhealth_core/lib/services/connectivity_service.dart:11-23,46-75`). | Remove it or keep both enqueue and replay disabled until every producer has an approved typed action, owner envelope, idempotency, and reconciliation contract. |
| Admin `createDowntimeSnapshot` export | Dead client export. Definition and re-exports exist, but no page, hook, component, or handler calls it (`apps/admin/src/lib/api/clinicalAiModules.ts:362-367`; `apps/admin/src/lib/api/emr.ts:1-4`; `apps/admin/src/lib/api/index.ts:197-217,325-337`). | No runtime actor, identity, canonical, SLA, or outbox behavior is reachable through this export. | None. | Remove the dead export or bind it only after the backend snapshot contract is classified. |
| Per-patient downtime snapshot writer | Live server route `POST /api/v1/emr/downtime-snapshot/:patientUid` (`apps/backend/src/routes/emr/clinicalNotesRoutes.js:480-518`) calls `clinicalTimelineService.createDowntimeSnapshot` (`apps/backend/src/services/emr/clinicalTimelineService.js:939-970`). No current UI caller was found. | URL patient UID and current JWT actor; clinical-staff, care-team/patient-view, tenant/RLS guards apply. Caller supplies scope and a bounded expiry request. Writer loads demographics and recent timeline, then inserts a `downtime_snapshots` row. It writes no canonical timeline, clinical audit, or SLA. It writes HIPAA access evidence and best-effort, non-atomic `downtime.snapshot.created` outbox evidence (`clinicalNotesRoutes.js:480-518`; `apps/backend/src/services/events/eventOutboxService.js:84-139`). Current readers select ward-pack scope, not the route's default patient-chart scope (`apps/backend/src/services/downtime/wardDowntimePackService.js:371-394`). | Online server-side precomputation, not a Staff/Patient queued mutation. Repeated calls have no idempotency middleware and can create repeated snapshot rows/events. Tenant safety depends on request-context RLS/GUC behavior because the writer does not pass tenant explicitly (`apps/backend/src/lib/prisma.js:452-485`; `apps/backend/prisma/schema.prisma:4663-4679`). | Inventory as an online cache generator. OWNER INPUT must decide retention, consumer, scope, tenant/facility binding, idempotency, and whether it remains. Do not treat it as an offline action. |

## 6. Proposed default-deny registry

This table is an engineering recommendation only. It does not supply C-D3
approval. Every exact endpoint binding remains denied until the stated owner
decision and route contract exist.

| Proposed stable action ID | Current endpoint binding | Recommended class or default-deny state | Approval still required |
|---|---|---|---|
| `op.prescription.draft` | **No binding to current** `POST /prescriptions/create` | `local_draft_only`; current authoritative create stays denied. | Clinical governance, prescribing, and pharmacy owners. |
| `ip.drug_chart.draft` | **No binding to current** `POST /emr/orders` | `local_draft_only`; current production CPOE create stays denied. | Clinical governance, inpatient prescribing, pharmacy, and nursing owners. |
| `mar.administration.backfill` | **No generic replay binding** to `POST /clinical/mar/:id/administer-with-scan` | `paper_only_backfill`; an override-bearing action remains `blocked_electronic`. | Clinical governance, nursing/medication-safety, and pharmacy owners. |
| `lab.specimen_collection.backfill` | **No generic replay binding** to `POST /lab/samples/:id/collect` | `paper_only_backfill`. | Laboratory/phlebotomy, clinical governance, and nursing owners as applicable. |
| `blood.transfusion_verification.backfill` | **No generic replay binding** to `POST /blood-bank/:id/verify-bedside` | `paper_only_backfill`. | Blood Bank, transfusion-safety/nursing, and clinical governance owners. |
| `emr.nursing_note.observation.capture` | **No binding to current generic** `POST /emr/notes` | Observation is unknown/default-deny. An owner-approved unsigned type may later qualify as `queueable_capture` only after the full contract exists. | Clinical governance plus the departmental owner for nursing observations. |
| `emr.nursing_note.medication_note.capture` | **No binding to current generic** `POST /emr/notes` | Medication Note is unknown/default-deny; narrative documentation must be separated from any medication action. | Clinical governance plus nursing and medication-domain owners. |
| `emr.nursing_note.post_procedure.capture` | **No binding to current generic** `POST /emr/notes` | Post-Procedure is unknown/default-deny; documentation must be separated from the performed physical action. | Clinical governance plus nursing and the responsible procedural owner. |
| `emr.nursing_note.intake_output.capture` | **No binding to current generic** `POST /emr/notes` | Intake/Output is unknown/default-deny; any future binding must use an owner-approved structured object rather than the generic note category. | Clinical governance plus nursing and the departmental owner of the structured I/O action. |
| `emr.nursing_note.patient_complaint.capture` | **No binding to current generic** `POST /emr/notes` | Patient Complaint is unknown/default-deny. An unsigned documentation class requires its own approved escalation and replay contract. | Clinical governance plus the departmental owner of complaint/escalation handling. |
| `emr.nursing_note.wound_care.capture` | **No binding to current generic** `POST /emr/notes` | Wound Care is unknown/default-deny; documentation must be separated from performed physical care. | Clinical governance plus nursing and the responsible wound/procedural owner. |
| `emr.nursing_note.shift_handover.capture` | **No binding to current generic** `POST /emr/notes` | Shift Handover is unknown/default-deny; any future binding must use an owner-approved structured handover object and acceptance contract. | Clinical governance plus nursing leadership and the structured-handover owner. |
| `emr.nursing_note.emergency.capture` | **No binding to current generic** `POST /emr/notes` | Emergency Note is unknown/default-deny; any future action requires visit/incident binding and departmental approval. | Clinical governance plus nursing and the emergency-domain owner. |
| `emr.nursing_note.other.capture` | **No binding to current generic** `POST /emr/notes` | Other remains unknown and fails closed; it cannot receive a generic replay permission. | Clinical governance plus a newly identified departmental owner after recategorization. |
| `vitals.capture` | **No binding to current** `POST /health/records` | Intended `queueable_capture`; current authoritative route remains denied until occurrence, identity, actor, idempotency, concurrency, canonical, and reconciliation requirements are met. | Clinical governance and nursing/vitals owners. |
| `emr.nursing_note.draft.store` | **No active binding until registry enforcement** to `PUT /emr/notes/draft` | Private `queueable_capture` draft storage only; never canonical or workflow-advancing. | Nursing governance, privacy, and security owners. |
| `emr.op_note.draft.store` | **No active binding until registry enforcement** to `PUT /emr/notes/draft` | Private `queueable_capture` draft storage only; never finalizes through replay. | OP clinical governance, privacy, and security owners. |
| `unknown` | Any unregistered method, endpoint, or action ID | Fail closed. | Explicit action-specific approval before any binding. |

## 7. Explicit contradiction and gap list

1. `op_prescription_draft` and `ip_drug_chart_draft` are declared
   `local_draft_only`, but Staff auto-replays their production create/order
   endpoints.
2. Every current `/emr/notes` category creates canonical note truth although
   the policy permits note drafts only; I/O and handover also bypass their
   structured domain objects.
3. A MAR row with an override reason intersects the declared
   `medication_safety_override` block. Plain MAR administration, specimen
   collection, and transfusion verification have no declared policy entry and
   are therefore unclassified authoritative captures rather than literal
   policy-text conflicts.
4. Policy names `vitals_draft`, but Staff creates an authoritative vital with
   no occurrence time, durable actor, encounter binding, or canonical
   timeline/audit. The ward procedure separately directs vitals to paper and
   governed back-entry.
5. Note-draft storage matches the draft-only intent, but its backend route has
   no action-registry enforcement, idempotency middleware, or stale-write
   protection.
6. The Staff policy getter has zero production callers
   (`apps/staff/lib/core/services/clinical_platform_api_service.dart:123-132`);
   declared policy therefore does not gate any current enqueue site.
7. The current ward procedure describes a JSON endpoint as a Staff offline
   cache feed, but repository search finds no Staff, Admin, or Patient consumer
   (`docs/DOWNTIME_PROCEDURE.md:21-25`).
8. The canonical invariant requires patient-related detail, timeline, and
   clinical audit in one transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md:73-95`).
   Vitals violates it entirely; several other rows omit original occurrence,
   encounter, or stable command identity from canonical evidence.

## 8. P0 quarantine list for C0A

The program-specified C0A containment list is exact and is not widened by this
dossier:

1. prescription create replay;
2. inpatient drug-chart order replay;
3. MAR administration replay;
4. specimen-collection replay;
5. transfusion-verification replay; and
6. authoritative clinical-note (`POST /emr/notes`) replay for every current
   note category.

C0A must stop new enqueue and automatic replay for those six families while
preserving existing rows as visible `needs_review`; it must not delete captured
evidence. The current vitals route is separately recommended default-deny in
C0.2, but adding it to the C0A implementation scope requires an explicit design
delta plus every existing §8 prerequisite and owner approval. This dossier does
not silently alter or authorize the gate.

## 9. Census reconciliation against design §3

**Delta: none.** The pinned repository still has the design's eight Staff
enqueue expressions:

- five physical/final actions: prescription create, drug-chart order, MAR
  administration, specimen collection, and transfusion verification;
- one authoritative clinical-note create;
- one authoritative vitals create; and
- one non-authoritative note-draft autosave.

Two clarifications do not change the count:

- the note-draft helper has two production UI attachments, nursing and OP
  consultation, but one enqueue expression/action class; and
- the authoritative nursing-note expression exposes nine clinical categories
  through one generic endpoint, so they require separate registry decisions
  without becoming nine enqueue call sites.

The dormant Patient queue, dead Admin export, and server-side per-patient
snapshot writer are auxiliary surfaces, not additional active Staff queue call
sites.
