# NL-13 Quaternary Specialty Suites Design Survey

Date: 2026-07-08
Worker branch: `docs/nl13-quaternary-suites-design`
Base reviewed: `github/main` at `548d8896c`
Status: design-only survey. No code, manifests, or migrations are changed by this document.

## Executive Finding

NL-13 should be built as six specialty workflow suites on top of the now-shipped N6/NL-7 rails, with cath lab and stroke first because the repository already has staff navigation, roles, device ingestion, theatre, anesthesia, NEWS2, code-blue alerting, radiology prioritization, and canonical timeline substrates for them. The current roadmap explicitly scopes NL-13 to invasive cardiology/cath-lab workflow, neuro/stroke pathway, transplant program management, oncology completion, CTVS/perfusion, and nuclear-medicine/radiotherapy coordination seams (docs/NEXT_LEVEL_ROADMAP.md:237-243), and it says Wave E is a design-first wave before implementation (docs/NEXT_LEVEL_ROADMAP.md:261-265).

The important baseline correction is that several "N6 rails" are already present on `github/main`, including device gateway tables, privilege catalog seeds, blood-bank donor/component/TTI flows, anatomic pathology case/block/slide/report flows, oncology chemo foundations, and infusion chair booking tables (apps/backend/src/migrations/371_device_registry.sql:1, apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5, apps/backend/src/migrations/383_ap_cases_gross.sql:3, apps/backend/src/migrations/404_blood_bank_tti_tests.sql:15, apps/backend/src/migrations/411_infusion_chairs.sql:8). NL-13 should extend those rails rather than re-propose their foundations.

## Non-Negotiable Boundaries

- Do not rebuild radiation planning, LINAC control, nuclear-medicine hardware control, genomics interpretation, or custom device protocol stacks. The roadmap marks genomics as explicitly deferred until a later oncology pull (docs/NEXT_LEVEL_ROADMAP.md:281), and it names nuclear-medicine/radiotherapy as coordination seams that integrate planning systems rather than rebuilding them (docs/NEXT_LEVEL_ROADMAP.md:242-243).
- Device payloads must route through NL-7 surfaces. The device registry already models device kind, protocol, status, and endpoint metadata (apps/backend/src/migrations/371_device_registry.sql:27-40), device-patient associations are audited and date-bounded (apps/backend/src/migrations/372_device_patient_associations.sql:1-9), and ingest policy separates control IDs, observations, suppression, and RLS (apps/backend/src/migrations/373_device_ingest_policy.sql:27-73).
- Every implemented patient-facing specialty action must produce canonical timeline and audit evidence. The canonical timeline guide says patient-facing actions write exactly one timeline event, one audit event, and SLA evidence when applicable (docs/CANONICAL_CLINICAL_TIMELINE.md:85-88), and the platform already has `clinical_timeline_events`, `clinical_audit_events`, and `workflow_sla_instances` tables (apps/backend/src/migrations/269_canonical_clinical_platform.sql:55-93, apps/backend/src/migrations/269_canonical_clinical_platform.sql:151-185).
- Privileged specialty acts should use the N6-5 credentialing pattern rather than inline role checks. The credentialing migration models staff privileges and active windows (apps/backend/src/migrations/287_staff_credentialing.sql:11-46), the privilege seed already includes examples such as chemo administration, primary surgeon, anesthesia finalize, ICU attending, and interventional radiology privileges (apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15), and the service exposes `hasActivePrivilege` plus `enforcePrivilegeGate` helpers (apps/backend/src/services/staff/credentialingService.js:685-725).
- Regulatory anchors must be owner-sourced. This design names the obligation surfaces for NOTTO and AERB adjacency, but it does not paraphrase or encode regulatory rules from memory.

## Current Substrates

### Staff, Role, And Cath-Lab Shell

The staff app already lists a `cath_lab/` feature folder (apps/staff/CLAUDE.md:45-72). The screen is currently a shell with schedule and readiness tabs, empty schedule state, room/team/equipment readiness rows, and no first-class procedure workflow (apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart:45-132). Backend role helpers already include `CATH_LAB_STAFF`, `CATH_LAB_INCHARGE`, and `canAccessCathLab` (apps/backend/src/utils/roleHelpers.js:21-22, apps/backend/src/utils/roleHelpers.js:294-306), and the role policy graph grants cath-lab workload/roster/workflow permissions plus a staff navigation feature (apps/backend/src/config/rolePolicyGraph.js:135-138, apps/backend/src/config/rolePolicyGraph.js:825-876, apps/backend/src/config/rolePolicyGraph.js:1042-1087). The organization hierarchy config also describes cath-lab incharge and staff duties around case readiness, equipment, lab, and blood-bank coordination (apps/backend/src/config/organizationHierarchyConfig.js:234-256).

### Theatre, Anesthesia, And Operative Documentation

Theatre documentation already includes surgical checklist, intraoperative notes, anesthesia records, implant records, and safety checklist entities (apps/backend/src/migrations/116_surgical_clinical_entities.sql:17-43). Anesthesia charts capture timestamped intraoperative measurements and interventions (apps/backend/src/migrations/163_anesthesia_chart_and_microbiology.sql:23-56). Theatre services already emit canonical clinical timeline and audit events around surgical cases (apps/backend/src/services/theatre/theatreService.js:454-474), and surgical documentation emits canonical clinical events as well (apps/backend/src/services/theatre/surgicalDocumentationService.js:208). These are the correct substrates for CTVS and perfusion seams.

### Device Gateway

NL-7 has first-class device registry, association, and ingest policy tables (apps/backend/src/migrations/371_device_registry.sql:1, apps/backend/src/migrations/372_device_patient_associations.sql:1, apps/backend/src/migrations/373_device_ingest_policy.sql:1). It supports HL7v2-style and HTTP/JSON-style protocol labels without implementing a custom protocol stack in each specialty (apps/backend/src/migrations/371_device_registry.sql:27-40), and it records device vital observations with suppression and RLS controls (apps/backend/src/migrations/373_device_ingest_policy.sql:46-73). Cath-lab hemodynamics, perfusion pump summaries, and monitored stroke-bed data should attach to NL-7 rather than inventing suite-specific ingestion.

### Stroke, Emergency, And Radiology Signals

The platform already has NEWS2 data structures and clinical alerting. `news2_scores` exists in the clinical AI foundation migration (apps/backend/src/migrations/009_future_proof_clinical_ai.sql:192-229), nursing assessments include NEWS2 and related screen kinds (apps/backend/src/migrations/161_nursing_assessments.sql:5-45), and clinical routes expose NEWS2 record/history endpoints (apps/backend/src/routes/clinical/clinicalRoutes.js:102-144). Critical vital alerts fan out to code-blue channels (apps/backend/src/utils/clinical/vitalSignMonitor.js:287-356, apps/backend/src/utils/clinical/vitalSignMonitor.js:434-503), with unit tests covering `staff:code-blue` and `staff:clinical-alerts` subscriptions (apps/backend/src/tests/unit/clinicalAlertsChannel.test.js:7-12).

Stroke-specific decision support also exists as a signal, not yet as a full pathway ledger. The pathway bundle service has a `stroke_gwg` preset with door-to-needle TPA and NIHSS measures (apps/backend/src/services/ai/pathwayBundleComplianceService.js:55-69), the radiology prioritizer recognizes `STROKE_PROTOCOL` and `code_stroke` context markers (apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:165, apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:326, apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:544-811), and tests confirm code-stroke CT-head prioritization (apps/backend/src/tests/unit/radiologyWorklistPrioritizerService.test.js:38-117). The rollout playbook and archived backlog also mark `stroke_fast_check_assistant` as a shipped Tier D emergency AI module (docs/PER_TENANT_ROLLOUT_PLAYBOOK.md:347-348, docs/archive/AI_FEATURE_GAP_BACKLOG.md:380-381).

### Blood Bank, Donor, And Transfusion Rails

Blood bank already has donor intake and safety workflow services. Donor registration, duplicate review, donor screening, deferral, donation events, and camp counters are handled in the donor intake service (apps/backend/src/services/bloodbank/donorIntakeService.js:259-345, apps/backend/src/services/bloodbank/donorIntakeService.js:421-462, apps/backend/src/services/bloodbank/donorIntakeService.js:640-707). Component preparation and TTI handling are present, including component plans, TTI results, reactive cascades, quarantines, deferrals, and discard events (apps/backend/src/services/bloodbank/donorProcessingService.js:11-18, apps/backend/src/services/bloodbank/donorProcessingService.js:169-185, apps/backend/src/services/bloodbank/donorProcessingService.js:236-400). TTI, component, register, discard, and donor camp migrations are also present (apps/backend/src/migrations/404_blood_bank_tti_tests.sql:15-105, apps/backend/src/migrations/405_blood_bank_component_preparations.sql:5-121, apps/backend/src/migrations/406_blood_bank_registers_discards.sql:5-97, apps/backend/src/migrations/407_blood_bank_donor_camps.sql:5-70).

Transfusion safety already records donor/donation links on registered units, crossmatches units against requests, emits canonical transfusion events, and records two-person bedside verification (apps/backend/src/services/bloodbank/transfusionSafetyService.js:116-139, apps/backend/src/services/bloodbank/transfusionSafetyService.js:164-224, apps/backend/src/services/bloodbank/transfusionSafetyService.js:339-351). Deep tests cover the register-unit to crossmatch to issue to bedside-verification loop (apps/backend/src/tests/transfusion-loop.deep.test.js:3-4, apps/backend/src/tests/transfusion-loop.deep.test.js:106-124, apps/backend/src/tests/transfusion-loop.deep.test.js:215).

### Anatomic Pathology And Oncology Rails

Anatomic pathology already has case, specimen, gross, block, slide, report, addendum, and turnaround-time foundations (apps/backend/src/migrations/383_ap_cases_gross.sql:3-125, apps/backend/src/migrations/384_ap_blocks_slides.sql:3-123, apps/backend/src/migrations/385_ap_reports_addenda_tat.sql:3-157). Pathology routes cover worklist, create case, gross, block, slide, draft/preliminary, sign-off, and addendum flows (apps/backend/src/routes/pathology/pathologyRoutes.js:48-230). The pathology service normalizes malignancy flags and stores synoptic fields on AP reports (apps/backend/src/services/pathology/pathologyService.js:128, apps/backend/src/services/pathology/pathologyService.js:668-742).

Oncology already has chemo protocol, drug, plan, cycle, administration, and cumulative-dose foundations (apps/backend/src/migrations/290_oncology_foundations.sql:20-184). The chemo service explicitly handles BSA dosing, cumulative limits, and optional credentialing privilege gates (apps/backend/src/services/oncology/chemoService.js:1-17, apps/backend/src/services/oncology/chemoService.js:104, apps/backend/src/services/oncology/chemoService.js:945-948). Infusion chair and booking tables exist and link chairs, cycles, patients, booking status, overlap prevention, and audit reasons (apps/backend/src/migrations/411_infusion_chairs.sql:8-60, apps/backend/src/migrations/412_chair_bookings.sql:12-83).

### Radiology, PACS, Nuclear Medicine, And Radiation Oncology Seams

Radiology already has a PACS direction with DICOM C-STORE/C-MOVE, Orthanc/OHIF, DICOMweb links, and a modality worklist integration note (docs/RADIOLOGY_PACS.md:14-35, docs/RADIOLOGY_PACS.md:225-263). NL-13 should reuse those imaging/document links for nuclear medicine and radiotherapy coordination. The roadmap explicitly says nuclear-medicine/radiotherapy are coordination seams and planning systems must be integrated, not rebuilt (docs/NEXT_LEVEL_ROADMAP.md:242-243).

## Suite 1 - Invasive Cardiology And Cath-Lab Workflow

### Exists

- Staff navigation, role policy, and organization hierarchy already know about cath lab (apps/staff/CLAUDE.md:45-72, apps/backend/src/utils/roleHelpers.js:21-22, apps/backend/src/config/rolePolicyGraph.js:135-138, apps/backend/src/config/organizationHierarchyConfig.js:234-256).
- A staff cath-lab screen exists, but it only renders schedule/readiness placeholders rather than procedure state (apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart:45-132).
- Theatre, anesthesia, surgical implants, canonical events, and device gateway rails can support invasive-procedure documentation and monitored data (apps/backend/src/migrations/116_surgical_clinical_entities.sql:17-43, apps/backend/src/migrations/163_anesthesia_chart_and_microbiology.sql:23-56, apps/backend/src/migrations/371_device_registry.sql:27-40).

### Gaps

- No first-class cath-lab case, cath procedure log, cath hemodynamic summary, EP case, TAVR seam, contrast/fluoroscopy record, cath complication ledger, post-cath order set, or device-data attachment ledger is visible in the surveyed cath-lab staff shell and backend role/policy surfaces (apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart:45-132, apps/backend/src/config/rolePolicyGraph.js:825-876).
- The privilege catalog has interventional radiology and surgical/anesthesia examples, but no cath-specific privilege key is seeded yet (apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15).

### Build Versus Integrate-Only

Build the cath-lab workflow ledger, readiness, procedure documentation, dose/contrast summaries, complications, post-procedure orders, and canonical timeline outputs. Integrate-only for angiography systems, hemodynamic monitors, EP systems, TAVR/vendor devices, and dose feeds through NL-7 or vendor documents. Do not build device protocol stacks inside cath-lab code because NL-7 owns device registry and ingest policy (apps/backend/src/migrations/371_device_registry.sql:27-40, apps/backend/src/migrations/373_device_ingest_policy.sql:46-73).

### Scope Sketch

- `cath_lab_cases`: patient, encounter, requested procedure, indication, urgency, lab room, status, planned/actual start/end, team, canonical timeline references.
- `cath_lab_readiness_checks`: consent, labs, allergy/renal-risk, anticoagulation, blood-bank readiness, equipment, implants/device rep, timeout.
- `cath_procedure_logs`: procedure type, access site, operators, sedation/anesthesia link, devices, findings summary, complications.
- `cath_hemodynamic_summaries`: summary observations and file/device references rather than raw waveform storage.
- `cath_contrast_radiation_records`: contrast volume, fluoroscopy time, dose fields, dose document links, AERB evidence attachment slot.
- `cath_post_procedure_orders`: recovery location, sheath/vascular closure, vitals frequency, antiplatelet/anticoagulation, complication watch.
- `cath_device_links`: NL-7 device association references, external system accession IDs, and inbound document IDs.

### Migration Estimate

Five to seven migrations: cases/readiness, procedure logs, hemodynamic summaries, contrast/radiation records, post orders, device links, and privilege/catalog seeds if the owner confirms cath-specific gates.

### Test Strategy

- Unit tests for readiness gating, cath case state transitions, contrast/radiation summary validation, privilege gate enforcement, and canonical event payloads.
- Deep integration test for order/request -> readiness -> procedure log -> dose/contrast summary -> post-order -> timeline/audit/SLA evidence.
- Contract test that cath-device links attach only to active NL-7 device-patient associations (apps/backend/src/migrations/372_device_patient_associations.sql:35-51).
- Staff widget/screen tests for schedule, readiness, procedure state, and empty/error states because the current UI is only a placeholder shell (apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart:45-132).

### Regulatory Anchor

AERB-adjacent cath-lab fluoroscopy and radiation-safety evidence must be sourced from the owner. The product should provide evidence attachment, dose summary, equipment QA reference, and audit slots, but should not encode regulatory text from model memory.

## Suite 2 - Neuro And Stroke Pathway

### Exists

- NEWS2 score storage, nursing assessments, NEWS2 routes, code-blue fanout, and clinical-alert tests are present (apps/backend/src/migrations/009_future_proof_clinical_ai.sql:192-229, apps/backend/src/migrations/161_nursing_assessments.sql:5-45, apps/backend/src/routes/clinical/clinicalRoutes.js:102-144, apps/backend/src/utils/clinical/vitalSignMonitor.js:434-503, apps/backend/src/tests/unit/clinicalAlertsChannel.test.js:7-12).
- Stroke has AI and radiology signal foundations: `stroke_gwg` compliance preset, `STROKE_PROTOCOL`, `code_stroke` prioritization, and tests for stat CT-head handling (apps/backend/src/services/ai/pathwayBundleComplianceService.js:55-69, apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:165, apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:326, apps/backend/src/tests/unit/radiologyWorklistPrioritizerService.test.js:38-117).

### Gaps

- Stroke currently appears as clinical AI/radiology prioritization signals, not as a first-class code-stroke pathway entity with activation, NIHSS, thrombolysis decision, timer, exclusion reason, team assignment, CT status handshake, and door-to-needle evidence (apps/backend/src/services/ai/pathwayBundleComplianceService.js:55-69, apps/backend/src/tests/unit/radiologyWorklistPrioritizerService.test.js:38-117).

### Build Versus Integrate-Only

Build the code-stroke pathway ledger, structured NIHSS capture, thrombolysis decision/evidence, door-to-CT and door-to-needle SLA instances, radiology handoff state, and canonical timeline events. Integrate-only for imaging viewers and device/vital streams through existing PACS and NL-7 surfaces (docs/RADIOLOGY_PACS.md:14-35, apps/backend/src/migrations/371_device_registry.sql:27-40).

### Scope Sketch

- `stroke_activations`: patient, encounter, activation source, last-known-well, arrival/door time, team, status, and canonical timeline event.
- `stroke_nihss_assessments`: structured items, total score, assessor, source/version owner field, audit.
- `stroke_thrombolysis_decisions`: eligibility, contraindications/exclusions, dose/decision fields, approver privilege, patient/family documentation slot.
- `stroke_pathway_events`: CT order, CT start/result, neurology review, decision, treatment start, transfer/disposition.
- Radiology link: reuse context markers such as `code_stroke` and `STROKE_PROTOCOL` instead of duplicating prioritization logic (apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:165-326).

### Migration Estimate

Four to five migrations: activations, NIHSS assessments, thrombolysis decisions, pathway events/SLA indexes, and privilege/catalog seeds.

### Test Strategy

- Unit tests for NIHSS total calculation, clock validation, eligibility/contraindication capture, status transitions, and privilege enforcement.
- Deep test for activation -> radiology prioritization -> CT status -> NIHSS -> thrombolysis decision -> timeline/audit/SLA evidence.
- Regression test that existing code-stroke radiology prioritization remains stat-tiered (apps/backend/src/tests/unit/radiologyWorklistPrioritizerService.test.js:94-117).
- Emergency-panel tests if staff/admin UI surfaces render `stroke_fast_check_assistant`, since the admin Tier D panel already describes stroke-fast and thrombolysis-window support (apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/TierDEmergencyPanel.tsx:85).

### Regulatory Anchor

Owner must provide the institutional thrombolysis protocol, NIHSS form/source/version policy, and local stroke quality reporting obligations. The app should store version/source metadata and evidence attachments rather than inventing clinical policy.

## Suite 3 - Transplant Program Management

### Exists

- Care-plan templates already include a transplant-related string in service logic (apps/backend/src/services/carePlan/carePlanService.js:28).
- Blood-bank donor, donation, TTI, component, quarantine, discard, and register rails exist (apps/backend/src/services/bloodbank/donorIntakeService.js:259-345, apps/backend/src/services/bloodbank/donorProcessingService.js:236-400, apps/backend/src/migrations/404_blood_bank_tti_tests.sql:15-105, apps/backend/src/migrations/405_blood_bank_component_preparations.sql:5-121, apps/backend/src/migrations/406_blood_bank_registers_discards.sql:5-97).
- Transfusion crossmatch and bedside-verification rails exist for blood products, including canonical transfusion events and deep tests (apps/backend/src/services/bloodbank/transfusionSafetyService.js:164-224, apps/backend/src/services/bloodbank/transfusionSafetyService.js:339-351, apps/backend/src/tests/transfusion-loop.deep.test.js:3-4).

### Gaps

- Blood donor and transfusion rails are not organ transplant program management. NL-13 still needs transplant program entities for candidates, waitlist status, donor referrals, recipient matching, organ offer decisions, transplant committee reviews, crossmatch chain-of-custody, immunosuppression plans, and NOTTO evidence/export tracking.

### Build Versus Integrate-Only

Build the hospital transplant program ledger, candidate/waitlist lifecycle, donor-referral intake, committee decision record, organ-offer decision evidence, crossmatch chain-of-custody record, post-transplant plan summary, and NOTTO evidence/export ledger. Integrate-only for external NOTTO registry/reporting surfaces until the owner supplies authoritative documents or API/export specifications.

### Scope Sketch

- `transplant_programs`: organ/service-line, site, program owner, status, NOTTO evidence owner fields.
- `transplant_candidates`: patient, diagnosis, listing evaluation status, committee status, contraindications summary, related care plan.
- `transplant_waitlist_status_history`: listed/hold/inactive/removed/transplanted status, reason, committee/audit link.
- `transplant_donor_referrals`: deceased/live donor referral, source, relation category, screening summary, documents.
- `transplant_match_reviews`: candidate, donor/referral, compatibility summary, crossmatch documents, risk flags, decision.
- `transplant_committee_reviews`: attendees, quorum policy reference, decision, recommendations, deferral reason.
- `transplant_immunosuppression_plans`: regimen summary, monitoring plan, prescribing owner, downstream medication links.
- `transplant_notto_exports`: generated package metadata, owner-reviewed status, upload/reference ID, audit evidence.

### Migration Estimate

Six to eight migrations: program/candidate core, waitlist history, donor referrals, match reviews, committee reviews, immunosuppression plan, NOTTO export ledger, and privilege/catalog seeds.

### Test Strategy

- Unit tests for waitlist status transitions, committee decision state, transplant privilege gates, and export package state transitions.
- Deep test for candidate evaluation -> committee review -> waitlist update -> donor referral -> match review -> timeline/audit evidence.
- Security tests for tenant isolation because donor/candidate data can cross patient subjects and must not leak across programs.
- Regression tests ensuring blood-bank donor and transfusion flows remain separate from organ-transplant donor/referral subjects.

### Regulatory Anchor

NOTTO alignment is mandatory as an owner-sourced obligation. The app should include explicit evidence owners, owner-reviewed export states, and document/reference slots, but should not encode NOTTO rules or allocation policy from model memory.

## Suite 4 - Oncology Completion

### Exists

- Oncology chemo protocols, plans, cycles, administrations, cumulative dose records, and optional chemo privilege enforcement exist (apps/backend/src/migrations/290_oncology_foundations.sql:20-184, apps/backend/src/services/oncology/chemoService.js:1-17, apps/backend/src/services/oncology/chemoService.js:945-948).
- Infusion chairs and chair bookings exist and link patients, cycles, statuses, overlap constraints, and audit reasons (apps/backend/src/migrations/411_infusion_chairs.sql:8-60, apps/backend/src/migrations/412_chair_bookings.sql:12-83).
- AP reporting stores malignancy flags and synoptic fields, which can feed oncology staging and tumor-board queues (apps/backend/src/services/pathology/pathologyService.js:128, apps/backend/src/services/pathology/pathologyService.js:668-742).

### Gaps

- The missing oncology layer is not first-dose chemotherapy. It is TNM/AJCC staging, CTCAE toxicity, tumor-board workflow, oncology registry/dashboard, and governance around externally sourced oncology terminology/content.

### Build Versus Integrate-Only

Build staging lifecycle, toxicity capture, tumor-board queue/meeting/recommendation workflow, AP-to-oncology referral, chemo-plan linkage, and oncology registry dashboards. Integrate-only for externally licensed staging/toxicity content sources unless owner approval allows local reference data.

### Scope Sketch

- `oncology_diagnoses`: patient, encounter, cancer site, pathology report link, diagnosis date, malignancy flag source.
- `oncology_staging_records`: TNM fields, AJCC edition/source/version, clinical/pathologic stage, assessor, verification.
- `oncology_toxicity_events`: CTCAE source/version, grade, attribution, action taken, cycle/admin link.
- `tumor_board_meetings`: service line, date, chair, attendees, quorum reference, status.
- `tumor_board_cases`: diagnosis, staging, AP/radiology links, question, priority, discussion state.
- `tumor_board_recommendations`: recommendation type, responsible owner, due date, acceptance/defer reason, timeline event.
- `oncology_registry_exports`: owner-reviewed export snapshots and evidence references.

### Migration Estimate

Four to six migrations: diagnosis/staging, toxicity events, tumor-board meetings/cases, recommendations/actions, registry/export ledger, and privilege/catalog seeds.

### Test Strategy

- Unit tests for TNM/stage field validation, CTCAE grade/source metadata, tumor-board state transitions, recommendation action due dates, and chemo-cycle linkage.
- Deep test for AP malignancy flag -> oncology diagnosis -> staging -> tumor board -> recommendation -> chemo-plan link -> canonical timeline/audit evidence.
- UI tests for tumor-board queue and toxicity capture.
- Content governance tests to ensure staging/toxicity source/version metadata is required before clinical sign-off.

### Regulatory And Content Anchor

The owner must provide AJCC/TNM and CTCAE source, edition/version, license/use policy, and tumor-board quorum policy. The product should store source/version metadata and references, but should not embed licensed staging or toxicity text without owner approval.

## Suite 5 - CTVS And Perfusion Seam

### Exists

- Theatre, intraoperative notes, anesthesia records, implant records, and anesthesia chart entries already exist (apps/backend/src/migrations/116_surgical_clinical_entities.sql:17-43, apps/backend/src/migrations/116_surgical_clinical_entities.sql:118-255, apps/backend/src/migrations/163_anesthesia_chart_and_microbiology.sql:23-56).
- Theatre and surgical documentation already emit canonical clinical events and audit events (apps/backend/src/services/theatre/theatreService.js:454-474, apps/backend/src/services/theatre/surgicalDocumentationService.js:208).
- NL-7 can hold external device associations and observations for perfusion/device attachment rather than a CTVS-specific protocol stack (apps/backend/src/migrations/371_device_registry.sql:27-40, apps/backend/src/migrations/372_device_patient_associations.sql:35-51).

### Gaps

- There is no dedicated perfusion summary, bypass-time record, ACT/temperature ledger, perfusionist sign-off, pump-data attachment, or CTVS-specific theatre overlay visible in the surveyed theatre/anesthesia entities.

### Build Versus Integrate-Only

Build a minimal CTVS/perfusion record seam linked to theatre cases and anesthesia charts. Integrate-only for perfusion pump/device data through NL-7 and vendor documents. Do not implement pump-specific protocol ingestion in CTVS code.

### Scope Sketch

- `ctvs_case_overlays`: theatre case link, procedure category, bypass expected, blood-product readiness, implant/device readiness.
- `perfusion_records`: theatre case, perfusionist, bypass start/end, cross-clamp start/end, ACT/temperature summaries, fluids/products summary, complications.
- `perfusion_device_links`: NL-7 association reference, vendor document reference, summary import status.
- `perfusion_signoffs`: perfusionist sign-off, surgeon review, anesthesia review, canonical event.

### Migration Estimate

Two to four migrations: CTVS overlays, perfusion records/signoffs, device/document links, and privilege/catalog seeds.

### Test Strategy

- Unit tests for bypass/cross-clamp time validation, sign-off gates, and theatre-case linkage.
- Deep test for theatre case -> perfusion summary -> anesthesia link -> canonical timeline/audit evidence.
- Contract test that perfusion device links require active NL-7 associations.
- Regression tests for theatre documentation so perfusion additions do not disturb existing surgical/anesthesia flows.

### Regulatory Anchor

Owner must provide perfusion record policy, perfusionist sign-off policy, and any device/vendor source documents. If hybrid theatre radiation is in scope, AERB-adjacent evidence must also be owner-sourced.

## Suite 6 - Nuclear Medicine And Radiotherapy Coordination

### Exists

- PACS/DICOM/OHIF direction and modality worklist integration notes already exist for radiology (docs/RADIOLOGY_PACS.md:14-35, docs/RADIOLOGY_PACS.md:225-263).
- The NL-13 roadmap explicitly narrows nuclear medicine and radiotherapy to coordination seams and says planning systems are integrated rather than rebuilt (docs/NEXT_LEVEL_ROADMAP.md:242-243).

### Gaps

- There is no visible first-class radiotherapy referral, treatment-plan reference, fraction schedule, nuclear-medicine order, radiopharmaceutical administration record, radiation-safety document ledger, or external planning-system link in the surveyed radiology/PACS and roadmap surfaces.

### Build Versus Integrate-Only

Build coordination, orders, appointment/fraction status, documentation links, safety checklist/evidence slots, patient instructions, and canonical timeline outputs. Integrate-only for treatment planning systems, LINAC delivery systems, nuclear-medicine scanners, dose calculation, isotope inventory systems, and hardware control.

### Scope Sketch

- `radiation_oncology_referrals`: patient, encounter, diagnosis/staging link, intent, urgency, referring clinician, status.
- `radiotherapy_plan_refs`: external planning-system reference, plan status, approving radiation oncologist, document link.
- `radiotherapy_fraction_schedules`: planned/actual fractions, status, hold/cancel reasons, external treatment reference.
- `nuclear_medicine_orders`: study/therapy type, isotope/radiopharmaceutical reference, appointment, preparation instructions.
- `radioisotope_administration_records`: administered activity summary, route, administrator, safety checklist, document links.
- `radiation_safety_evidence`: AERB-adjacent owner-sourced evidence documents and QA references.

### Migration Estimate

Three to five migrations: referrals/orders, plan/fraction references, nuclear medicine orders/administration, safety evidence ledger, and privilege/catalog seeds.

### Test Strategy

- Unit tests for referral/order/fraction state transitions, hold/cancel reasons, privilege gates, and required external-reference metadata.
- Deep test for oncology diagnosis/staging -> radiotherapy referral -> external plan reference -> fraction schedule -> timeline/audit evidence.
- Guardrail tests proving the product stores external references and does not calculate treatment plans or control delivery systems.
- PACS link regression tests for image/document references because radiology already exposes OHIF/DICOMweb-oriented links (docs/RADIOLOGY_PACS.md:14-35, docs/RADIOLOGY_PACS.md:225-227).

### Regulatory Anchor

AERB-adjacent radiation-equipment licensing, QA, radiation-safety, radioisotope handling, and treatment-delivery evidence must be owner-sourced. The app should capture evidence ownership and references, not encode regulatory requirements from memory.

## Recommended Slice Order

1. **NL13-P1 Cath-lab workflow skeleton.** This has the highest reuse of already visible staff navigation, cath roles, theatre/anesthesia, device gateway, and blood-bank coordination surfaces (apps/staff/CLAUDE.md:45-72, apps/backend/src/config/organizationHierarchyConfig.js:234-256, apps/backend/src/migrations/116_surgical_clinical_entities.sql:17-43, apps/backend/src/migrations/371_device_registry.sql:27-40).
2. **NL13-P2 Stroke activation, timers, and NIHSS.** NEWS2, code-blue fanout, radiology prioritization, and stroke AI signals already exist, but they need a clinical pathway ledger (apps/backend/src/migrations/009_future_proof_clinical_ai.sql:192-229, apps/backend/src/utils/clinical/vitalSignMonitor.js:434-503, apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:165-326).
3. **NL13-P3 Oncology staging, CTCAE, and tumor board.** Chemo, AP malignancy flags, synoptic fields, and infusion chair scheduling are already present, making oncology completion a coherent next implementation slice (apps/backend/src/migrations/290_oncology_foundations.sql:20-184, apps/backend/src/services/pathology/pathologyService.js:668-742, apps/backend/src/migrations/411_infusion_chairs.sql:8-60).
4. **NL13-P4 Nuclear medicine and radiotherapy coordination.** This should follow oncology staging because radiation referrals depend on diagnosis/stage context, and the roadmap keeps this as an integration seam (docs/NEXT_LEVEL_ROADMAP.md:242-243).
5. **NL13-P5 CTVS/perfusion seam.** Theatre and anesthesia substrates are ready, but pilot value depends on whether the owner wants full CTVS workflow or only perfusion summary capture (apps/backend/src/migrations/116_surgical_clinical_entities.sql:17-43, apps/backend/src/migrations/163_anesthesia_chart_and_microbiology.sql:23-56).
6. **NL13-P6 Transplant program management.** This has the highest owner-decision and regulatory burden because NOTTO alignment, organ program scope, and external registry/export obligations must be owner-sourced before implementation.

## Owner Decisions Before Build

- Cath lab: vendor/source of truth for angiography, hemodynamics, EP, TAVR/device data, and fluoroscopy dose documents; AERB evidence owner; cath-specific privilege keys.
- Stroke: stroke activation clock definitions, thrombolysis policy, NIHSS source/version, stroke team roles, and quality-reporting obligations.
- Transplant: pilot organ scope, live/deceased donor scope, NOTTO document/export/API source, committee policy, allocation/match review boundaries, and transplant privilege keys.
- Oncology: AJCC/TNM source and edition, CTCAE source/version and license policy, tumor-board quorum/specialty rules, oncology registry/export expectations, and oncology privilege keys.
- CTVS/perfusion: CTVS pilot scope, perfusion pump vendor, summary-versus-import split, perfusionist sign-off policy, and hybrid-OR radiation evidence owner if applicable.
- Nuclear medicine/radiotherapy: planning-system and LINAC vendor list, integration mode, nuclear-medicine scanner/order system boundary, AERB evidence owner, isotope/radiation-safety documentation scope, and radiation-oncology privilege keys.

## Build Ledger

- Scope executed: NL-13 docs-only design survey across invasive cardiology/cath-lab, neuro/stroke, transplant, oncology completion, CTVS/perfusion, and nuclear-medicine/radiotherapy seams.
- Files changed: `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md` only.
- Migrations created: none.
- Code/manifests changed: none.
- Build versus integrate-only boundaries recorded: cath device data via NL-7, stroke imaging via PACS/radiology, transplant NOTTO external registry/export seam, oncology external terminology governance, CTVS pump/device data via NL-7, nuclear/radiotherapy planning and delivery systems external only.
- Regulatory anchors recorded without paraphrasing rules from memory: NOTTO for transplant owner sources; AERB adjacency for cath fluoroscopy and radiation/nuclear/radiotherapy owner sources.
- Validation status: `git diff --check` passed; citation target scan found 151 repo citations and 0 missing or out-of-range file/line targets. The required backend local gate was attempted after `npm --prefix apps/backend run db:generate`; chunks 1-2 passed, chunk 3 passed on rerun after an admission chunk interaction, chunks 4-6 passed, and chunk 7 exposed an unrelated baseline contract failure in `src/tests/billing-v2-invoice-contract.deep.test.js` (`InvoiceV2DetailResponse` rejects extra response properties) that reproduces in isolation on current `github/main`. No code, migration, manifest, or OpenAPI fixes were made because this worker is docs-only.
