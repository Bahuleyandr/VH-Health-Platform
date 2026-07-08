# NL-14 critical-care and emergency depth design

Status: Wave E NL-14 survey/design. Docs-only; no migrations in this PR.

## 1. Survey verdict

VH Health already has the right substrate for NL-14, but it is not yet a complete critical-care or emergency chart. The core opportunity is not another generic vitals table. It is durable, unit-specific high-acuity documentation that consumes the NL-7 device pipeline, writes clinically reviewable ICU/ED/NICU/burn records, and feeds only the data it owns into N6-6 device-day denominators.

Grounding:

- Vitals already flow through `recordVitals`, NEWS2, canonical timeline events, and device-unverified tags (`apps/backend/src/services/emr/vitalsChartService.js:430`, `apps/backend/src/services/emr/vitalsChartService.js:591`, `apps/backend/src/services/emr/vitalsChartService.js:608`).
- NL-7 already defines device registry, association, charting interval, artifact filter, suppression, unassociated parking, and clinician verification (`apps/backend/src/migrations/371_device_registry.sql:3`, `apps/backend/src/migrations/372_device_patient_associations.sql:3`, `apps/backend/src/migrations/373_device_ingest_policy.sql:3`, `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:123`, `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:134`, `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:156`).
- ICU has an older manual flowsheet with unit codes including PICU/NICU, ventilator fields, drips, I/O, RASS/CAM-ICU, SOFA/CPOT, and ABCDEF bundle fields (`apps/backend/src/migrations/165_icu_flowsheet.sql:1`, `apps/backend/src/migrations/165_icu_flowsheet.sql:32`, `apps/backend/src/migrations/165_icu_flowsheet.sql:80`, `apps/backend/src/migrations/165_icu_flowsheet.sql:152`, `apps/backend/src/migrations/165_icu_flowsheet.sql:205`).
- ED has visits, triage, ambulance requests, and MLC records, plus Tier-D assistants for triage, ambulance handover, trauma checklists, and MLC drafts (`apps/backend/src/migrations/126_ed_operational_entities.sql:12`, `apps/backend/src/migrations/126_ed_operational_entities.sql:129`, `apps/backend/src/migrations/126_ed_operational_entities.sql:190`, `apps/backend/src/services/ed/edOperationsService.js:33`, `apps/backend/src/services/ai/tierDEmergencyService.js:95`, `apps/backend/src/services/ai/tierDEmergencyService.js:345`, `apps/backend/src/services/ai/tierDEmergencyService.js:366`).
- Code Blue exists as realtime fan-out and an incident runbook, but durable resuscitation documentation does not exist. The existing spec says code-blue events are not persisted with ward/bed/reason context and the banner is live-only (`docs/superpowers/specs/2026-06-29-realtime-dashboards-clinical-alerts-design.md:24`, `docs/superpowers/specs/2026-06-29-realtime-dashboards-clinical-alerts-design.md:25`; runbook trigger model at `apps/backend/docs/RUNBOOKS/code-blue-misfire.md:26`).
- N6-6 now owns HAI device-day math through `device_presence_logs`, `hai_cases`, and `hai_device_rate_per_1000_device_days` (`apps/backend/src/migrations/398_hai_device_surveillance.sql:8`, `apps/backend/src/services/quality/infectionControlWorkbenchService.js:18`, `apps/backend/src/services/quality/infectionControlWorkbenchService.js:176`, `apps/backend/src/services/quality/infectionControlWorkbenchService.js:690`, `apps/backend/src/services/quality/infectionControlWorkbenchService.js:880`, `apps/backend/src/services/quality/nabhIndicatorService.js:160`).
- Theatre/anesthesia documentation is deep enough to reuse for peri-resuscitation handoff lessons: preop, intraop, postop, anesthesia, implants, WHO safety checklist, and complication alerts already exist (`apps/backend/src/migrations/116_surgical_clinical_entities.sql:17`, `apps/backend/src/migrations/116_surgical_clinical_entities.sql:209`, `apps/backend/src/services/theatre/surgicalDocumentationService.js:197`, `apps/backend/src/services/theatre/surgicalDocumentationService.js:856`, `apps/backend/src/services/theatre/anesthesiaChartService.js:4`).

## 2. Device-density and charting policy

NL-14 must consume NL-7's downsampled, governance-owned policy rather than bypassing it. The gateway forwards all samples to the backend, but persistence is paced by chart interval, critical/warning pass-through, NEWS2 delta, and artifact/suppression rules (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:123`, `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:134`, `apps/backend/src/services/emr/deviceVitalsService.js:333`, `apps/backend/src/services/emr/deviceVitalsService.js:473`, `apps/backend/src/services/emr/deviceVitalsService.js:510`).

Unit assumptions:

| Unit | Device density assumption | NL-14 charting policy |
| --- | --- | --- |
| Adult ICU/CCU | Continuous bedside monitor, ventilator, infusion pumps, urinary catheter, central line, drains; one central station may multiplex channels. | Persist NL-7 vital snapshots per configured interval and all breach/NEWS2-delta events; chart RASS/CAM-ICU, ventilator mode changes, lines/tubes/drains, drips, and I/O as nurse/RT-authored records. Do not infer line/device presence from a monitor alone. |
| PICU | Adult ICU pattern plus paediatric weights, age-specific norms, family/caregiver notes. | Use the same ICU grid with paediatric calculators/reference content surfaced as decision support; keep medication and growth references in NL-5-owned content. |
| NICU | Dense SpO2/HR/temp monitor data, incubator/warmer, ventilator/CPAP, syringe pumps, feeds/fluids, Apgar/birth substrate. | Persist physiologic snapshots through NL-7, but model feeds, fluids, jaundice, neonatal scores, ventilation/oxygen mode, and incubator/warmer observations explicitly. APGAR/birth records already exist (`apps/backend/src/migrations/155_maternity_workflow.sql:240`, `apps/backend/src/migrations/155_maternity_workflow.sql:283`). |
| ED resus/trauma | Short-lived high-density monitor/defib/ventilator stream, often before admission bed assignment. | Bind device samples to ED visit/resus bay association, not stale bed strings. Persist high-acuity episodes and handover snapshots. ED queue/flow stays NL-8. |
| Ambulance/pre-hospital | Partner-dependent; may be manual, device-gateway local push, or no integration. | NL-14 stores the clinical handover, observations, interventions, and linked ED visit. NL-7 owns any transport/auth/protocol adapter. |
| Burns | Usually manual TBSA/wound/fluid charting unless ICU-level monitoring is active. | TBSA maps and fluid protocols are content/decision support. Continuous vitals remain NL-7/vitals; burns math and protocols must come through NL-5 content studio governance. |

## 3. Governance boundaries

- Scoring calculators are decision support. RASS, CAM-ICU, SOFA, CPOT, SBT readiness, trauma checklist gaps, triage suggestions, burn TBSA/fluid prompts, and neonatal scores must store input facts, output scores, references, version, and reviewer identity. They must not place orders, change ventilator settings, stop sedation, or auto-finalize clinical documentation. The existing ventilator/sedation module already states that rule (`apps/backend/src/migrations/049_icu_ventilator_sedation_bundle.sql:3`, `apps/backend/src/migrations/049_icu_ventilator_sedation_bundle.sql:54`, `apps/backend/src/services/ai/icuVentilatorBundleService.js:10`).
- Protocol content belongs to NL-5 P3/P4. The content studio is the author/review/approve/version/deploy lane for order sets and pathway content (`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:25`, `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:477`, `apps/backend/src/migrations/381_order_set_content_studio_governance.sql:11`, `apps/backend/src/migrations/381_order_set_content_studio_governance.sql:117`). Burns fluid protocols, weaning pathways, sedation bundles, neonatal feed/fluids pathways, and trauma packs consume that content; they are not hardcoded in NL-14.
- Pediatric reference content belongs to NL-5 P4. IAP growth and UIP/IAP immunization packs already have a content-pack design and plug into growth/immunization services (`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:28`, `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:606`, `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:636`).
- BCMA/MAR safety remains the medication substrate. The two-scan gate and duplicate administered-dose guard are already authoritative (`apps/backend/src/migrations/309_bcma_scan_timestamps.sql:6`, `apps/backend/src/services/clinical/marFiveRightsService.js:165`, `apps/backend/src/services/clinical/marFiveRightsService.js:234`, `apps/backend/src/migrations/327_mar_duplicate_administration_guard.sql:45`). ICU sedation/drip documentation should reference MAR administrations, not create a parallel medication-administration lane.

## 4. Slice designs

### 4.1 P1 - ICU flowsheet depth, ventilation, sedation, and device-presence source events

**Exists.** Manual ICU admissions/flowsheets already capture unit, bed, severity, ventilator mode/settings, vasoactive drips, I/O, drain output, RASS/CAM-ICU, SOFA/CPOT, and ABCDEF bundle (`apps/backend/src/migrations/165_icu_flowsheet.sql:32`, `apps/backend/src/migrations/165_icu_flowsheet.sql:107`, `apps/backend/src/migrations/165_icu_flowsheet.sql:117`, `apps/backend/src/migrations/165_icu_flowsheet.sql:133`, `apps/backend/src/migrations/165_icu_flowsheet.sql:169`, `apps/backend/src/migrations/165_icu_flowsheet.sql:219`). Device vitals already enter `recordVitals(source='device')` and remain unverified until review (`apps/backend/src/services/emr/deviceVitalsService.js:599`, `apps/backend/src/services/emr/deviceVitalsService.js:628`).

**Gaps.** The current ICU table is an hourly/manual row, not a device-aware ICU chart. It does not model ventilator episodes/weaning trials as durable records, does not lifecycle lines/tubes/drains as start/stop events, does not feed N6-6 `device_presence_logs`, and does not clearly bind NL-7 device observations into an ICU flowsheet view.

**Scope sketch.**

- Add an ICU charting service that hydrates a patient/day view from manual flowsheet rows, verified/unverified device vitals, NEWS2, MAR, I/O, and current line/tube/drain presence.
- Add explicit ventilation records and weaning/SBT trial records: mode, settings, oxygen device, start/stop, reason, responsible clinician, linked device observation IDs where applicable.
- Add line/tube/drain presence events for central line, urinary catheter, ventilator/ETT/tracheostomy, arterial line, drains, feeding tubes, dialysis access, and oxygen device. Only central line, urinary catheter, and ventilator map into N6-6 HAI denominator device types; others remain ICU chart facts.
- Create an adapter that writes or closes N6-6 `device_presence_logs` for denominator devices only, preserving N6-6 ownership of HAI logic and rate computation.
- Surface RASS/CAM-ICU/CPOT/SOFA/SBT calculators as versioned decision-support outputs with references and reviewer signoff, not order-mutating actions.

**Migration estimate.** 6 to 8 future migrations: ICU chart policy/versioning, ventilation episodes, weaning trials, line/tube/drain events, ICU-device observation links, ICU scoring outputs, ICU UI preference/audit tables, and optional materialized daily summary. No migration numbers are used in this docs PR.

**Tests.** Backend deep test for ORU/device ingest to unverified vitals to ICU chart hydration; device association end on discharge/transfer; line/tube/drain start/stop to `device_presence_logs`; HAI denominator clipping; ventilation/weaning lifecycle; RASS/CAM/SOFA calculator fixtures; MAR-linked sedation/drip references; tenant isolation. Staff/admin widget tests for ICU chart density, unverified device badges, and line presence lifecycle.

### 4.2 P2 - ED triage, trauma activation, surveys, and MLC completeness

**Exists.** ED visits, triage assessments, ambulance requests, and MLC records exist in the operational schema (`apps/backend/src/migrations/126_ed_operational_entities.sql:12`, `apps/backend/src/migrations/126_ed_operational_entities.sql:129`, `apps/backend/src/migrations/126_ed_operational_entities.sql:181`). The service supports ESI, Manchester, CTAS, ATS/PAT variants and orders untriaged/critical patients carefully (`apps/backend/src/services/ed/edOperationsService.js:33`, `apps/backend/src/services/ed/edOperationsService.js:37`, `apps/backend/src/services/ed/edOperationsService.js:370`). Tier-D can suggest triage priority, trauma checklists, and MLC drafts, but those remain assistants (`apps/backend/src/services/ai/tierDEmergencyService.js:98`, `apps/backend/src/services/ai/tierDEmergencyService.js:350`, `apps/backend/src/services/ai/tierDEmergencyService.js:396`).

**Gaps.** There is no durable trauma-team activation table, no structured primary/secondary survey record, no trauma timeline, no MLC completeness gate, and no tenant-level choice of a single canonical triage scale. The ambulance handover assistant reads from `ambulance_requests`, but the underlying table is dispatch/status-focused rather than rich pre-hospital observation/intervention documentation.

**Scope sketch.**

- Add tenant ED policy selecting one canonical triage scale and mapping alternatives only for imported/legacy records.
- Add trauma activations with activation reason, activation level, team roles, arrival times, blood bank/radiology/OT alerts, and link to ED visit/admission.
- Add primary and secondary survey records: airway, breathing, circulation, disability, exposure, FAST/imaging, interventions, reassessment time, responsible clinician, and source citations.
- Add MLC completeness rules: alleged history, injury diagram/description, police notification, certificate signer, chain of custody attachments, and closure requirements. The MLC draft assistant may prefill but cannot certify.
- Integrate vital snapshots and device observations from NL-7 as encounter evidence, not as an ED-specific vitals transport.

**Migration estimate.** 4 to 6 future migrations: ED policy, trauma activations/team roles, survey records, trauma timeline/interventions, MLC completeness/audit, and optional injury diagram attachments. No migration numbers are used in this docs PR.

**Tests.** Triage scale policy validation; ED visit to triage to board order; trauma activation role/time invariants; survey record required-field validation; MLC incomplete cannot certify; assistant outputs cannot bypass human signoff; device vitals evidence linked to ED visit; tenant and PHI access tests.

### 4.3 P2 - Code-blue and resuscitation documentation

**Exists.** Realtime code-blue channel and FCM fan-out exist (`apps/backend/src/utils/websocket/realtimeEmitter.js:31`, `apps/backend/src/utils/websocket/realtimeEmitter.js:42`, `apps/backend/src/utils/websocket/channelAuth.js:86`). Critical vitals can fan out as code-blue events (`apps/backend/src/utils/clinical/vitalSignMonitor.js:434`). The runbook documents explicit and vital-derived triggers (`apps/backend/docs/RUNBOOKS/code-blue-misfire.md:26`, `apps/backend/docs/RUNBOOKS/code-blue-misfire.md:28`, `apps/backend/docs/RUNBOOKS/code-blue-misfire.md:33`).

**Gaps.** Code Blue is an alert, not a resuscitation record. The dashboard spec explicitly calls out missing persisted code-blue history with ward/bed/reason context (`docs/superpowers/specs/2026-06-29-realtime-dashboards-clinical-alerts-design.md:25`, `docs/superpowers/specs/2026-06-29-realtime-dashboards-clinical-alerts-design.md:186`). There is no structured event timeline for CPR, shocks, airway, drugs, ROSC/death/transfer, or team attendance.

**Scope sketch.**

- Add `resuscitation_events` for code-blue/rapid-response events with patient, encounter/admission/ED visit, location snapshot, trigger source, start/stop, outcome, team leader, recorder, and post-event note status.
- Add append-only `resuscitation_event_timeline`: compressions, rhythm checks, shocks, airway, medication administrations linked to MAR where possible, defib energy, labs, fluids, blood products, procedures, ROSC, transfer, death declaration.
- Keep realtime channel as notification only. Creating/updating the durable resus event may emit to `staff:code-blue`, but WS delivery remains at-most-once and never becomes the source of truth.
- Extend `code-blue-misfire.md` to include durable resus event reconciliation in the future implementation PR.

**Migration estimate.** 4 to 5 future migrations: resus event header, event timeline, team roles/signatures, medication/MAR/defib links, and post-event QA/debrief. No migration numbers are used in this docs PR.

**Tests.** Explicit code-blue trigger creates durable event and realtime notification; critical-vital-derived code-blue links to alert/device evidence; timeline append is ordered and immutable; MAR-linked epinephrine/fluids do not double-administer; missing team leader/recorder blocks finalization; patient/tenant/PHI guard tests; reconnect dashboard hydrates persisted events instead of relying on live-only banner.

### 4.4 P2/P3 - Ambulance and pre-hospital seam

**Exists.** `ambulance_requests` captures dispatch status, unit, driver, attendant, priority, requested/on-scene/arrived timestamps, patient, destination, and notes (`apps/backend/src/migrations/126_ed_operational_entities.sql:129`, `apps/backend/src/services/ed/edOperationsService.js:608`, `apps/backend/src/services/ed/edOperationsService.js:663`). Tier-D can draft an SBAR handover from an ambulance request row (`apps/backend/src/services/ai/tierDEmergencyService.js:224`, `apps/backend/src/services/ai/tierDEmergencyService.js:241`).

**Gaps.** There is no structured pre-hospital observation/intervention timeline, no ambulance partner identity/consent boundary, no en-route vitals source model, and no handover acceptance/signature.

**Scope sketch.**

- Add ambulance encounter/handover records linked to ambulance request and ED visit: pickup context, scene observations, en-route vitals/interventions, allergies/meds reported, ETA changes, receiving nurse/doctor acceptance, and handover signed-at.
- Treat en-route device vitals as NL-7 transport: ambulance monitor/device auth, local-push adapter, and store-and-forward are not NL-14-owned. NL-14 only consumes verified/unverified observations once NL-7 delivers them.
- Support a manual-only path for partner fleets without integration, with the same handover acceptance workflow.

**Migration estimate.** 3 to 5 future migrations: ambulance partner/fleet config if needed, pre-hospital handover header, pre-hospital observation/intervention timeline, handover acceptance signatures, and optional device links. No migration numbers are used in this docs PR.

**Tests.** Manual handover lifecycle; ED visit creation from ambulance handover; ambulance status transitions remain valid; partner-supplied payload cannot write patient chart without accepted handover/device association; Tier-D handover draft cites only supplied rows; tenant and PHI guard tests.

### 4.5 P3 - NICU/PICU feeds, fluids, neonatal scoring, and pediatric references

**Exists.** ICU admissions allow `PICU` and `NICU` unit codes (`apps/backend/src/migrations/165_icu_flowsheet.sql:32`). Maternity/newborn substrate includes newborn record, resuscitation type, breastfeeding initiation, APGAR scores, newborn patient link, postnatal baby feeding/jaundice fields, and newborn immunizations (`apps/backend/src/migrations/155_maternity_workflow.sql:240`, `apps/backend/src/migrations/155_maternity_workflow.sql:254`, `apps/backend/src/migrations/155_maternity_workflow.sql:261`, `apps/backend/src/migrations/155_maternity_workflow.sql:283`, `apps/backend/src/migrations/160_newborn_immunisations.sql:91`). Patient immunizations cover walk-ins/transfers outside maternity (`apps/backend/src/migrations/179_paediatric_immunisations.sql:14`).

**Gaps.** NICU/PICU does not have a dedicated feeds/fluids balance, neonatal ventilation/oxygen mode chart, incubator/warmer observations, neonatal scoring rows, jaundice/phototherapy timeline, or device-fleet assumptions. Existing APGAR is birth-context only, not NICU acuity scoring.

**Scope sketch.**

- Extend ICU charting with PICU/NICU-specific views rather than a separate silo: weight-adjusted fluid balance, feeds (breast milk/formula/fortifier/TPN), urine/stool/emesis, glucose, bilirubin, phototherapy, oxygen/CPAP/ventilator mode, incubator/warmer temperature, apnea/brady/desaturation events.
- Add neonatal and paediatric score output rows as decision support with references and human review. Candidate scores need owner approval before build; do not hardcode formulas in UI.
- Consume NL-5 IAP growth and UIP/IAP immunization packs once signed, and keep local fallbacks labelled as such.

**Migration estimate.** 5 to 7 future migrations: NICU/PICU feed-fluid chart, neonatal respiratory support, neonatal/pediatric score outputs, jaundice/phototherapy events, incubator/warmer observations, device links, and specialty UI preferences. No migration numbers are used in this docs PR.

**Tests.** Feed/fluid balance fixtures by weight; APGAR/newborn link to NICU admission; device vitals unverified badges in NICU; score outputs carry version/reference/reviewer; growth/immunization content pack lookup; tenant isolation; staff widget tests for dense neonatal rows.

### 4.6 P3 - Burns charting, TBSA map, and fluid protocol content

**Exists.** ED/MLC already recognizes burn as an MLC kind (`apps/backend/src/migrations/126_ed_operational_entities.sql:190`, `apps/backend/src/services/ed/edOperationsService.js:58`). Content studio governance exists for versioned order sets/pathways (`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:736`, `apps/backend/src/migrations/381_order_set_content_studio_governance.sql:63`, `apps/backend/src/migrations/381_order_set_content_studio_governance.sql:117`, `apps/backend/src/migrations/382_content_studio_settings.sql:3`).

**Gaps.** There is no burn encounter, TBSA body map, burn-depth site chart, serial wound/photograph trail, fluid-resuscitation worksheet, escharotomy/debridement/procedure timeline, or content-governed burn protocol.

**Scope sketch.**

- Add a burn chart linked to ED visit/admission/MLC: mechanism, time of injury, first aid, inhalation risk, circumferential burns, comorbid risks, wound sites/depth, and serial reassessment.
- Add TBSA body-map data as structured regions with age-template metadata and clinician override. The output is decision support with reference/version, not a hidden formula.
- Pull fluid protocol templates, analgesia, tetanus, wound-care, transfer, and follow-up pathways from NL-5 content studio once approved. The NL-14 UI can render and record clinician decisions, but should not own Parkland or local protocol constants.

**Migration estimate.** 4 to 6 future migrations: burn chart header, burn wound/TBSA regions, burn reassessment/media metadata, burn fluid worksheet outputs, and protocol-content links. No migration numbers are used in this docs PR.

**Tests.** MLC burn to burn chart link; TBSA region totals with versioned reference and override; fluid worksheet references approved content; missing content fails closed with "protocol unavailable" rather than fallback math; serial wound assessment timeline; tenant/PHI/media guard tests.

## 5. Slice order and dependencies

1. **ICU flowsheet depth P1.** Dependency: NL-7 P1 device registry/associations/policy must be merged and verified; N6-6 `device_presence_logs` must stay the only HAI denominator table. This is the highest payoff because it connects device density, ventilation/weaning, sedation/delirium, and infection-control denominators.
2. **Code-blue/resuscitation P2.** Dependency: existing realtime/code-blue channel and clinical-alert history. Build after ICU P1 data model decisions so resus timeline can reuse medication/device/line links.
3. **ED triage/trauma/MLC P2.** Dependency: owner decision on canonical triage scale and trauma registry posture. Can run in parallel with resus if the same event/timeline primitives are settled first.
4. **Ambulance/pre-hospital P2/P3.** Dependency: owner decision on integration scope and partner devices. Manual handover can ship before any partner/device integration.
5. **NICU/PICU P3.** Dependency: NL-5 pediatric content packs, NICU device fleet decision, and ICU P1 chart substrate.
6. **Burns P3.** Dependency: NL-5 content studio live with burn pathway content and owner-approved TBSA/fluid references.

## 6. Owner decisions

1. **Triage scale.** Pick one canonical tenant scale for the ED before implementation: ESI, ATS, CTAS, or Manchester. The backend can store several strings today, but NL-14 should not let a unit mix scales in active operations.
2. **Trauma registry participation.** Decide whether trauma data is internal only, state/partner exported, or registry-ready. This determines identifiers, minimum dataset, retention, and export surfaces.
3. **Ambulance partner integration scope.** Decide internal fleet only, named partner API/device integration, or manual handover first. If devices are in scope, NL-7 owns the transport and credentials.
4. **NICU device fleet.** Name supported monitors, ventilators/CPAP, incubators/warmers, infusion/syringe pumps, and whether they can push locally. This affects NL-7 device kinds and NL-14 chart widgets.
5. **Clinical governance owners.** Name approvers for alarm/charting policy, ICU scoring calculators, sedation/weaning protocols, neonatal scores, burn TBSA/fluid references, and order-set content.

## 7. Explicit boundaries

- **NL-7 owns transport.** Gateway apps, MLLP/HTTP framing, device credentials, device registry, device-patient association, downsampling, artifact filtering, suppression, unassociated message parking, and device metrics stay in NL-7. NL-14 consumes device observations and presents clinical documentation.
- **NL-8 owns queue and flow surfaces.** ED board, bed queue, transfer queues, and operational throughput stay NL-8. NL-14 can emit clinical events or status hints, but it does not own the queue engine.
- **N6-6 owns HAI logic.** NL-14 may create/close denominator source facts for lines/tubes/drains, but HAI attribution, device-day rate math, snapshots, outbreak logic, and infection-control workbench remain N6-6.
- **NL-5 owns content.** Protocol text, order-set versions, burn fluids, weaning pathways, pediatric content packs, and calculator references are approved content artifacts. NL-14 records use and review, not the authoritative clinical rules.
