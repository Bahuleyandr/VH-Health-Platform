# AI Feature Gap Backlog

**Scope:** This doc audits a **user-facing AI feature catalogue** (~250 features
labelled `AI_*`) against the **78 registered modules** in
`clinical_ai_modules` and the ~78 service files under
`apps/backend/src/services/ai/`. It complements — but does not overlap —
`HEALTHCARE_AI_SPEC_AUDIT.md` (which audits the broader 38-section entity /
infra spec) and `CLINICAL_AI_ROLLOUT_PLAN.md` (which tracks the
substrate / multi-agent rollout).

**Audited:** 2026-04-30 against `main`.
**Method:** enumerated `CLINICAL_AI_MODULES` in
`apps/backend/src/services/ai/clinicalAiModuleService.js`, walked
`apps/backend/src/services/ai/`, the 13 route files in
`apps/backend/src/routes/admin/clinicalAi/`, the dual-plane
`/control/*` + `/clinical/*` split, the Flutter `apps/staff/lib/`
clinician screens, and the patient app. Cross-referenced each catalogue
ID against existing modules / services.

---

## TL;DR

The substrate the catalogue assumes — *rule-authoritative, AI-advisory,
every output logged + reviewable + explainable + human-approved, WHO-style
governance* — **is already built and shipped on `main`**. The gap is
breadth: a long tail of P0/P1 *use cases* the substrate could host but
currently doesn't. Headline numbers:

| Status | Count (out of ~250 catalogue items) |
|---|---|
| Present (registered module or substrate-equivalent) | ~155 |
| Partial (substrate exists; specific use case needs surfacing) | ~30 |
| Missing | ~65 |

Three substrate-level safety holes are worth fixing **before** building
new modules. They're listed first below.

The "First-20 build order" the catalogue prescribes is **14/20 fully
done · 3/20 partial · 3/20 missing** — see §18.

---

## How to read

Verdict legend used throughout:

- ✅ implemented as a registered module or substrate-equivalent
- ⚠️ partial — the substrate exists, but the specific catalogue ID's
  use case still needs surfacing or finishing
- ❌ missing

Module names in `monospace` (e.g. `patient_record_summary`) are
`module_key` values from `CLINICAL_AI_MODULES`.

---

## Substrate posture vs. governance asks

The catalogue's "must-have" governance properties — every clinical
output should be logged, reviewable, explainable, and human-approved —
all map to existing infrastructure:

| Governance ask | Status | Where |
|---|---|---|
| Every AI output logged | ✅ | `clinical_ai_generations` (provider/model/prompt_version/source_hash/tokens) + `clinical_ai_workflow_runs` (state/checkpoints/started_by) |
| Reviewable | ✅ | `clinical_ai_reviews` queue + Flutter staff `/clinical-ai/queue` + `/clinical-ai/review/:id` |
| Explainable | ✅ | `aiExplainabilityDashboardService` + `clinical_ai_explainability_reports`; admin overview tab |
| Human-approved | ✅ | Approval as workflow pause-gate (`pauseRun('await_governance')` + `clinical_ai_approvals`); 4-decision sign-off (Accept / Accept-edits / Needs-revision / Reject) |
| Decision-support only (rule-authoritative) | ✅ | Pharmacy `VALID_TRANSITIONS` state machine; lab autoverification rules-first (AI narrative only); radiology QA rules-first; `cdsEngine` typed alerts |
| Model versioning + rollback | ✅ | `modelRegistryWorkbenchService` stages: sandbox → staging → production → deprecated → quarantined |
| Per-tenant feature flags | ✅ | `clinical_ai_modules.enabled` per tenant |
| Citation grounding | ✅ | `hallucinationDefenses.runOutputDefenses(draft, module, context, citations)` |
| PHI leakage detection | ✅ | `hallucinationDefenses.detectPhiLeaks` (UID/phone/email/MRN regex; CRITICAL halts generation) + `consentPhiPolicySentinelService` |
| Local-LLM tier (PHI never leaves building) | ✅ | `localLlmClient` Ollama provider + `CLINICAL_AI_DEEP_*` env vars; LAN-only ingress for `/clinical/*` |
| Region-aware provider routing | ✅ | `CLINICAL_AI_EXTERNAL_REGIONS` allowlist |

**Verdict: governance substrate is at or above what the catalogue
prescribes.** Real gaps below.

---

## Substrate-level safety holes (fix these first)

These are **not** missing features — they are gaps that weaken the
existing safety story and should be closed before the next paying-customer
launch.

### S1. No prompt-injection detector for ingested documents

**Problem:** RAG and document intelligence both ingest external
PDFs/images. `services/ai/` has no `documentPromptInjectionDetector`. The
only related artifact is one adversarial test in
`tests/adversarial/hallucinationAdversarial.test.js`. RAG context flows
into LLM prompts, so a malicious lab report could try to override
clinician-facing instructions.

**Fix scope:** new service module `documentPromptInjectionDetectorService.js`
+ pre-ingestion gate in `documentIntelligenceService` and
`ragService.backfillSignedDischargeSummaries`. Treat retrieved/uploaded
content as untrusted by default.

### S2. `clinical_protocols` table is empty

**Problem:** Migration 093 created it; without seed data the
protocol-reminder pass in `cdsEngine` returns no alerts even though the
surface works. (Already noted as item 1.5 in
`project_vh_health_unification.md`.)

**Fix scope:** seed migration with sepsis bundle, VTE prophylaxis, DVT,
ARDS, ICU/ED handover protocols. Needs clinical sign-off.

### S3. Bias-monitoring telemetry is absent

**Problem:** Eval runs track accuracy / F1 / safety / drift, but **not by
age / sex / language / disease group / facility**. WHO governance
guidance specifically calls this out.

**Fix scope:** extend `clinical_ai_model_eval_runs` schema +
`driftCanaryService` to slice metrics on demographic axes. Add bias
panel to admin governance dashboard.

### S4. CDS Hooks JSON-card contract is missing

**Problem:** `cdsEngine` returns internal alert objects, **not**
standards-compliant CDS Hooks cards. Catalogue explicitly names
`patient-view`, `order-select`, and `order-sign` cards. This blocks
third-party EHR integration.

**Fix scope:** adapter at `routes/clinical/cdsHooksRoutes.js` translating
existing alerts into CDS Hooks JSON cards. Substrate is fine; we just
don't speak the standard yet.

### S5. No regulatory-readiness pack exporter

**Problem:** Substrate generates everything CDSCO / EU MDR / FDA SaMD
reviewers want (model registry, eval runs, drift, incidents, reviews)
but there's no one-click "export evidence pack for module X v1.2" flow.

**Fix scope:** background job + admin button. Output: zipped manifest of
model versions, eval results, drift logs, incident reports, prompt
versions, review decisions for the named module + version range.

---

## Section-by-section gap map

Tables list catalogue ID → status → mapping (module name or note on what
exists). Sections follow the catalogue's own ordering (§1–§17) for easy
cross-reference.

### §1 Doctor / clinical copilot

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_PATIENT_SUMMARY | ✅ | `patient_record_summary` |
| AI_VISIT_PREP_BRIEF | ✅ | `daily_ward_round_brief` |
| AI_TIMELINE_SUMMARY | ✅ | `multimodal_patient_timeline` |
| AI_CLINICAL_NOTE_CLEANUP | ❌ | No "rough notes → clean notes" rewriter |
| AI_SOAP_NOTE_DRAFT | ✅ | `soap_from_dictation` |
| AI_FOLLOW_UP_PLAN_DRAFT | ⚠️ | Subsumed under `patient_aftercare_instructions`; carve out a doctor-facing follow-up plan module |
| AI_REFERRAL_LETTER_DRAFT | ✅ | `referral_letter` |
| AI_PATIENT_INSTRUCTIONS_DRAFT | ✅ | `patient_aftercare_instructions` |
| AI_MEDICAL_CERTIFICATE_DRAFT | ❌ | Missing — fitness/sickness/rest cert templates |
| AI_CLINIC_LETTER_DRAFT | ❌ | Missing — OPD consultation letter |
| AI_DIFFERENTIAL_DIAGNOSIS_ASSISTANT | ✅ | `clinicalDebateService` (multi-LLM debate) |
| AI_MISSING_QUESTIONS_ASSISTANT | ❌ | Missing |
| AI_MISSING_EXAMINATION_ASSISTANT | ❌ | Missing |
| AI_MISSING_TESTS_ASSISTANT | ❌ | Missing (substrate ready) |
| AI_PROBLEM_LIST_GENERATOR | ⚠️ | `clinicalKnowledgeGraphService` produces problem entities; no dedicated active/inactive surface |
| AI_DIAGNOSIS_CODING_ASSISTANT | ✅ | `clinical_coding_assist` |
| AI_ORDER_SET_SUGGESTION | ❌ | `cdsEngine` reads `order_sets`; no AI suggestion module |
| AI_CLINICAL_GUIDELINE_QA | ⚠️ | RAG corpus + `clinical_protocols` table exist (mig 093, **empty — see S2**); module surface absent |
| AI_RISK_FLAG_SUMMARY | ⚠️ | Rolled into `patient_record_summary`; no standalone risk dashboard |
| AI_SECOND_OPINION_SUMMARY | ❌ | Missing |
| AI_CONSULTATION_TRANSCRIPTION | ✅ | `sttService` + `ambientDiarizationService` |
| AI_AMBIENT_VISIT_DOCUMENTATION | ✅ | `ambient_visit_documentation` |
| AI_CLINICAL_PATHWAY_RECOMMENDER | ⚠️ | `pathway_bundle_compliance` audits adherence but doesn't recommend pathway |
| AI_PERSONALIZED_CARE_PLAN | ❌ | Missing |
| AI_PREDICTIVE_DISEASE_PROGRESSION | ✅ | `longitudinalRiskService` |
| AI_READMISSION_RISK | ✅ | `longitudinalRiskService` (30-day) |
| AI_MORTALITY_RISK_ASSISTANT | ✅ | `longitudinalRiskService` |
| AI_AUTONOMOUS_CLINICAL_AGENT | ✅ | Workflow runner + HITL approval gate is exactly this pattern |

### §2 Patient-facing

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_PATIENT_HEALTH_ASSISTANT | ✅ | `patient_record_chatbot` |
| AI_REPORT_EXPLAINER | ❌ | Missing as standalone — `patient_teach_back_comprehension` is post-discharge only |
| AI_PRESCRIPTION_EXPLAINER | ❌ | Missing |
| AI_DISCHARGE_EXPLAINER | ✅ | `patient_aftercare_instructions` |
| AI_MULTILINGUAL_EXPLANATION | ✅ | `patient_communication_translation` (8 Indic langs) |
| AI_APPOINTMENT_ROUTER | ⚠️ | `voice_patient_assistant_ivr` covers booking/refills via voice; no symptom→specialty router |
| AI_PRE_VISIT_FORM_ASSISTANT | ❌ | Missing |
| AI_MEDICATION_REMINDER_GENERATOR | ❌ | Missing |
| AI_FOLLOW_UP_REMINDER_GENERATOR | ❌ | Missing |
| AI_PATIENT_FAQ_ASSISTANT | ⚠️ | `patient_record_chatbot` partly; hospital-FAQ scope absent |
| AI_SYMPTOM_RED_FLAG_CHECKER | ❌ | `SymptomCheckerScreen` shows published outputs but no live red-flag detector |
| AI_CHRONIC_DISEASE_COACH | ❌ | Missing |
| AI_POST_DISCHARGE_CHECKIN_BOT | ❌ | Missing |
| AI_POST_SURGERY_MONITORING_BOT | ❌ | Missing |
| AI_HOME_VITALS_INSIGHTS | ❌ | Missing |
| AI_PATIENT_DOCUMENT_UPLOAD_ASSISTANT | ⚠️ | `document_intelligence_ocr` does the heavy lifting; patient-app UX wrapper absent |
| AI_CAREGIVER_ASSISTANT | ✅ | `consent_aware_family_update` |
| AI_DIET_ADVICE_DRAFT | ❌ | Missing |
| AI_EXERCISE_ADVICE_DRAFT | ❌ | Missing |
| AI_MENTAL_HEALTH_SCREENING_BOT | ❌ | Missing |
| AI_PERSONAL_HEALTH_TWIN | ❌ | Missing (P3) |
| AI_PREVENTIVE_HEALTH_RECOMMENDER | ❌ | Missing |
| AI_FAMILY_HEALTH_RISK_SUMMARY | ❌ | Missing |
| AI_REMOTE_PATIENT_MONITORING_AGENT | ⚠️ | `virtual_ward_triage` covers eligibility, not continuous monitoring loop |

### §3 Lab AI

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_LAB_RESULT_SUMMARY | ✅ | `lab_autoverification_delta` (rules-first + AI narrative) |
| AI_LAB_PATIENT_EXPLANATION | ❌ | Missing standalone |
| AI_LAB_ABNORMAL_VALUE_DETECTOR | ✅ | `lab_autoverification_delta` |
| AI_LAB_CRITICAL_VALUE_ALERT | ✅ | `cdsEngine` critical lab values + autoverification critical band |
| AI_LAB_TREND_SUMMARY | ⚠️ | Trend bridges in `longitudinalRiskService`; no per-analyte trend module |
| AI_LAB_REPORT_OCR_EXTRACTION | ✅ | `documentOcrAdapter` + `document_intelligence_ocr` |
| AI_LAB_DUPLICATE_TEST_DETECTOR | ⚠️ | `cdsEngine` has duplicate orders detection at order time, not retrospective |
| AI_LAB_PENDING_RESULT_REMINDER | ❌ | Missing |
| AI_LAB_INTERPRETATION_ASSISTANT | ⚠️ | Folded into autoverification narrative |
| AI_CRITICAL_LAB_ESCALATION_ASSISTANT | ⚠️ | Critical alerts exist; escalation chain not AI-driven |
| AI_LAB_ORDER_SUGGESTION | ❌ | Missing |
| AI_LAB_PRE_ANALYTICAL_ERROR_DETECTOR | ❌ | Missing |
| AI_LAB_REFERENCE_RANGE_SELECTOR | ⚠️ | Reference ranges live in inline columns (mig 088); age/sex/pregnancy-aware AI selector absent |
| AI_LAB_REPORT_VALIDATION_ASSISTANT | ⚠️ | Autoverification covers lab-staff use case |
| AI_DISEASE_PATTERN_FROM_LABS | ❌ | Missing |
| AI_LONGITUDINAL_RISK_FROM_LABS | ✅ | `longitudinalRiskService` |
| AI_LAB_MACHINE_ANOMALY_DETECTION | ⚠️ | `driftCanaryService` is for ML drift, not analyzer QC |

### §4 Radiology / imaging

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_RADIOLOGY_REPORT_SUMMARY | ⚠️ | `radiology_report_qa` does QA, not pure summary |
| AI_RADIOLOGY_PATIENT_EXPLANATION | ❌ | Missing |
| AI_RADIOLOGY_REPORT_TEMPLATE_ASSISTANT | ❌ | Missing |
| AI_RADIOLOGY_IMPRESSION_EXTRACTOR | ❌ | Missing |
| AI_RADIOLOGY_FOLLOWUP_REMINDER | ❌ | Missing |
| AI_RADIOLOGY_CRITICAL_FINDING_ALERT | ✅ | `radiology_worklist_prioritizer` |
| AI_RADIOLOGY_DISCREPANCY_CHECKER | ⚠️ | `radiology_report_qa` partly |
| AI_IMAGING_ORDER_APPROPRIATENESS_ASSISTANT | ❌ | Missing |
| AI_ECG_REPORT_EXPLAINER | ❌ | Missing |
| AI_ECHO_REPORT_SUMMARY | ❌ | Missing |
| AI_XRAY_ABNORMALITY_DETECTION (P3) | ✅ | `radiology_ai_interpretation` (wraps external models) |
| AI_CT_MRI_IMAGE_ASSISTANT (P3) | ⚠️ | Same wrapper; specific tasks not validated |
| AI_ULTRASOUND_ASSISTANT (P3) | ⚠️ | Same wrapper |

### §5 Prescription / pharmacy

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_DRUG_INTERACTION_CHECK | ✅ | `cdsEngine` (typed) |
| AI_ALLERGY_CONFLICT_CHECK | ✅ | `cdsEngine` |
| AI_DUPLICATE_THERAPY_CHECK | ✅ | `cdsEngine` |
| AI_PRESCRIPTION_INSTRUCTION_GENERATOR | ❌ | Missing |
| AI_MEDICATION_TIMING_NORMALIZER | ❌ | Missing |
| AI_PHARMACY_SUBSTITUTE_SUGGESTION | ❌ | Missing |
| AI_NEAR_EXPIRY_STOCK_ALERT | ⚠️ | `inventory_intelligence` covers stock but not specifically expiry |
| AI_LOW_STOCK_PREDICTION | ✅ | `pharmacy_stockout_predictor` |
| AI_RENAL_DOSE_CHECK | ❌ | Missing |
| AI_LIVER_DOSE_CHECK | ❌ | Missing |
| AI_PREGNANCY_LACTATION_WARNING | ⚠️ | `obstetric_risk_assistant` partial |
| AI_PEDIATRIC_DOSE_CHECK | ✅ | `pediatric_dosing_safety` |
| AI_GERIATRIC_MEDICATION_WARNING | ⚠️ | `polypharmacy_ai_review` covers polypharmacy but not specifically Beers criteria |
| AI_HIGH_RISK_MEDICATION_ALERT | ⚠️ | `cdsEngine` flags high-risk classes |
| AI_ANTIBIOTIC_STEWARDSHIP_ASSISTANT | ✅ | `antimicrobial_stewardship` |
| AI_MEDICATION_RECONCILIATION | ✅ | `medication_reconciliation` (CRITICAL-tier, deep model) |
| AI_ADVERSE_DRUG_EVENT_DETECTOR | ❌ | Missing |
| AI_PHARMACY_DEMAND_FORECAST | ✅ | `inventory_intelligence` |
| AI_PROCUREMENT_RECOMMENDER | ✅ | `procurement_negotiation_assistant` |
| AI_PERSONALIZED_MEDICATION_RISK | ✅ | `pharmacogenomics_support` |
| AI_AUTOMATED_FORMULARY_OPTIMIZATION | ❌ | Missing |
| AI_CLOSED_LOOP_MEDICATION_SAFETY | ⚠️ | Substrate exists but end-to-end loop (rx → dispense → administer → adherence) not threaded as one module |

### §6 Nursing / IPD / ICU

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_NURSE_HANDOVER_SUMMARY | ✅ | `handover_summary` |
| AI_DAILY_INPATIENT_SUMMARY | ✅ | `daily_ward_round_brief` |
| AI_NURSING_TASK_GENERATOR | ✅ | `clinical_task_extractor` |
| AI_VITALS_ABNORMALITY_ALERT | ⚠️ | `deterioration_early_warning` does composite NEWS2; pure single-vital flag is rule-side |
| AI_INTAKE_OUTPUT_SUMMARY | ❌ | `intake_output` table exists; AI summary module missing |
| AI_MEDICATION_ADMINISTRATION_REMINDER | ❌ | Missing |
| AI_PENDING_TASK_ALERT | ⚠️ | `clinical_task_extractor` partial |
| AI_EARLY_WARNING_SCORE | ✅ | `deterioration_early_warning` (NEWS2 composite) |
| AI_DETERIORATION_RISK_ALERT | ✅ | Same |
| AI_SEPSIS_RISK_ALERT | ✅ | `sepsis_bundle_sentinel` |
| AI_AKI_RISK_ALERT | ❌ | Missing |
| AI_FALL_RISK_PREDICTION | ❌ | Missing |
| AI_PRESSURE_ULCER_RISK_PREDICTION | ❌ | Missing |
| AI_ICU_ROUND_SUMMARY | ⚠️ | `icu_ventilator_sedation_bundle` partial (audit only) |
| AI_DISCHARGE_READINESS_PREDICTION | ✅ | `discharge_readiness` |
| AI_PATIENT_HANDOVER_BETWEEN_DEPARTMENTS | ⚠️ | `handover_summary` shift-only; cross-dept variant absent |
| AI_CONTINUOUS_MONITORING_AGENT | ❌ | Missing — would need device-stream ingestion |
| AI_ICU_PREDICTIVE_ANALYTICS | ❌ | Missing |
| AI_AUTONOMOUS_NURSING_WORKFLOW_AGENT | ⚠️ | Workflow runner pattern fits; no dedicated nursing agent module |

### §7 Emergency / triage

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_EMERGENCY_TRIAGE_FORM_ASSISTANT | ❌ | Missing |
| AI_RED_FLAG_DETECTION | ⚠️ | `deterioration_early_warning` covers inpatients, not ED first contact |
| AI_TRIAGE_PRIORITY_SUGGESTION | ⚠️ | `ed_triage_boarding_predictor` is a boarding-time forecaster, not ESI/Manchester triage |
| AI_EMERGENCY_SUMMARY | ❌ | Missing |
| AI_AMBULANCE_HANDOVER_SUMMARY | ❌ | Missing |
| AI_STROKE_FAST_CHECK_ASSISTANT | ❌ | Missing |
| AI_CHEST_PAIN_PROTOCOL_ASSISTANT | ⚠️ | `pathway_bundle_compliance` audits, doesn't drive workflow |
| AI_SEPSIS_PROTOCOL_ASSISTANT | ✅ | `sepsis_bundle_sentinel` |
| AI_TRAUMA_CHECKLIST_ASSISTANT | ❌ | Missing |
| AI_MLC_DOCUMENTATION_ASSISTANT | ❌ | Missing |

### §8 Discharge

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_DISCHARGE_SUMMARY_DRAFT | ✅ | `discharge_summary` |
| AI_DISCHARGE_INSTRUCTION_DRAFT | ✅ | `patient_aftercare_instructions` |
| AI_DISCHARGE_MEDICATION_EXPLANATION | ⚠️ | Folded into aftercare; standalone surface absent |
| AI_DISCHARGE_FOLLOWUP_GENERATOR | ⚠️ | Folded into aftercare |
| AI_DISCHARGE_MISSING_INFO_CHECK | ✅ | `discharge_readiness` |
| AI_DISCHARGE_TRANSLATION | ✅ | `patient_communication_translation` |
| AI_DISCHARGE_DELAY_PREDICTION | ⚠️ | `bed_discharge_forecast` is occupancy-side; per-patient delay reason missing |
| AI_DISCHARGE_CLEARANCE_ASSISTANT | ⚠️ | `discharge_readiness` checks clinical readiness; pharmacy/billing/insurance gates not unified |
| AI_POST_DISCHARGE_RISK_SCORE | ✅ | `longitudinalRiskService` |
| AI_PENDING_REPORT_TRACKER | ❌ | Missing |

### §9 Surgery / OT — **weakest single area**

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_PRE_OP_CHECKLIST_REVIEW | ❌ | Missing |
| AI_SURGICAL_CONSENT_DRAFT | ❌ | Missing |
| AI_OT_NOTE_DRAFT | ❌ | Missing |
| AI_POST_OP_INSTRUCTION_DRAFT | ❌ | Missing |
| AI_IMPLANT_CONSUMABLE_TRACKER | ❌ | Missing |
| AI_OT_SCHEDULING_OPTIMIZER | ✅ | `ot_block_scheduling` |
| AI_SURGICAL_RISK_SUMMARY | ❌ | Missing |
| AI_ANESTHESIA_PRECHECK_ASSISTANT | ❌ | Missing |
| AI_POST_OP_COMPLICATION_ALERT | ⚠️ | `housekeeping_bed_turnover` + `deterioration_early_warning` only generic |
| (extra in registry) | ✅ | `ot_case_time_predictor` exists, fits AI_OT_DURATION |

Substrate exists (workflow runner, deep tier, governance) but the
surgical checklists, consents, OT notes, anesthesia pre-check are all
absent. Any hospital with an OR will feel this immediately.

### §10 Document AI / OCR

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_DOCUMENT_CLASSIFICATION | ✅ | `document_intelligence_ocr` |
| AI_DOCUMENT_OCR | ✅ | `documentOcrAdapter` (multi-provider) |
| AI_DOCUMENT_SUMMARY | ⚠️ | Within document intelligence; not standalone |
| AI_DOCUMENT_ENTITY_EXTRACTION | ✅ | Within document intelligence |
| AI_DOCUMENT_PATIENT_MATCHING | ❌ | Missing |
| AI_DUPLICATE_DOCUMENT_DETECTION | ❌ | Missing (only draft fingerprint via `hallucinationDefenses.draftFingerprint`) |
| AI_EXTERNAL_REPORT_IMPORT | ⚠️ | Document intelligence covers reads; structured-field write-back patchy |
| AI_DOCUMENT_SEARCH | ✅ | `ragService` (pgvector + Ollama embed) |
| AI_CONFLICTING_INFORMATION_DETECTOR | ❌ | Missing |
| AI_MEDICAL_RECORD_BUNDLE_GENERATOR | ⚠️ | FHIR `routes/fhir/` exists; AI-assisted bundle for insurance/referral missing |
| AI_CHART_GAP_DETECTOR | ✅ | `chart_completion_auditor` |
| **AI_DOCUMENT_PROMPT_INJECTION_DETECTOR** | ❌ | **See S1** |

### §11 Billing / coding / insurance

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_INVOICE_EXPLANATION | ❌ | Missing |
| AI_BILLING_ITEM_SUGGESTION | ⚠️ | `charge_capture_audit` retrospective, not suggestion |
| AI_MISSING_CHARGE_DETECTION | ✅ | `charge_capture_audit` |
| AI_INSURANCE_DOCUMENT_CHECKLIST | ⚠️ | `prior_authorization_generator` partial |
| AI_CLAIM_SUMMARY_DRAFT | ⚠️ | `prior_authorization_generator` partial |
| AI_PREAUTH_LETTER_DRAFT | ✅ | `prior_authorization_generator` |
| AI_PACKAGE_COMPLIANCE_CHECK | ❌ | Missing |
| AI_CLAIM_DENIAL_RISK | ✅ | `denial_risk_assist` |
| AI_CLAIM_QUERY_RESPONSE_DRAFT | ✅ | `appeal_letter_generator` |
| AI_CODING_ASSISTANT | ✅ | `clinical_coding_assist` |
| AI_REVENUE_LEAKAGE_DETECTION | ⚠️ | `payer_contract_variance` partly |
| AI_BILLING_ANOMALY_DETECTION | ⚠️ | Same |
| AI_TARIFF_OPTIMIZATION_INSIGHTS | ❌ | Missing |

### §12 Hospital operations

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_NO_SHOW_PREDICTION | ✅ | `appointment_no_show_predictor` |
| AI_QUEUE_WAIT_TIME_PREDICTION | ⚠️ | ED only via `ed_triage_boarding_predictor` |
| AI_SMART_QUEUE_OPTIMIZATION | ❌ | Missing |
| AI_DOCTOR_SCHEDULE_ASSISTANT | ⚠️ | `staff_roster_optimizer` covers staff, not doctor-specific load |
| AI_FRONT_DESK_ASSISTANT | ⚠️ | `voice_patient_assistant_ivr` for voice; text/web front-desk absent |
| AI_PATIENT_FEEDBACK_SUMMARY | ❌ | Missing |
| AI_SENTIMENT_ANALYSIS | ❌ | Missing |
| AI_BED_OCCUPANCY_FORECAST | ✅ | `bed_discharge_forecast` |
| AI_ADMISSION_DEMAND_FORECAST | ✅ | `acuity_staffing_forecast` |
| AI_DISCHARGE_FORECAST | ✅ | `bed_discharge_forecast` |
| AI_STAFF_ROSTER_OPTIMIZER | ✅ | `staff_roster_optimizer` |
| AI_LAB_TAT_DELAY_PREDICTION | ❌ | Missing |
| AI_RADIOLOGY_TAT_DELAY_PREDICTION | ❌ | Missing |
| AI_HOUSEKEEPING_TASK_OPTIMIZER | ✅ | `housekeeping_bed_turnover` |
| AI_AMBULANCE_DEMAND_FORECAST | ❌ | Missing |
| AI_EQUIPMENT_UTILIZATION_ANALYTICS | ⚠️ | `biomed_device_maintenance` partial |
| AI_HOSPITAL_COMMAND_CENTER | ✅ | `hospital_command_center` |
| AI_CAPACITY_PLANNING | ✅ | `acuity_staffing_forecast` |
| AI_PROCUREMENT_FORECASTING | ✅ | `inventory_intelligence` + `blood_bank_demand_forecast` |
| AI_OPERATIONAL_BOT | ✅ | `operationalAiService` + `admin_policy_copilot` |

### §13 Public / population health — **largely missing as a domain**

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_DISEASE_CLUSTER_DETECTION | ✅ | `infection_control_sentinel` |
| AI_ANTIBIOTIC_RESISTANCE_DASHBOARD | ⚠️ | Inside infection control, not surfaced |
| AI_CHRONIC_DISEASE_REGISTRY | ❌ | Missing |
| AI_SCREENING_GAP_DETECTION | ❌ | Missing |
| AI_HIGH_RISK_PATIENT_COHORTS | ⚠️ | `clinical_trial_matcher` partly |
| AI_PUBLIC_HEALTH_REPORT_GENERATOR | ❌ | Missing |
| AI_OUTBREAK_EARLY_WARNING | ✅ | `infection_control_sentinel` |

### §14 Research / trials

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_COHORT_FINDER | ⚠️ | `clinical_trial_matcher` partial |
| AI_TRIAL_MATCHING | ✅ | `clinical_trial_matcher` |
| AI_ELIGIBILITY_CRITERIA_PARSER | ⚠️ | `trialCatalogSyncService` partial |
| AI_RETROSPECTIVE_STUDY_ASSISTANT | ❌ | Missing |
| AI_DEIDENTIFICATION | ⚠️ | `synthetic_case_generator` adjacent; no PHI-stripper for arbitrary records |
| AI_RESEARCH_SUMMARY_GENERATOR | ❌ | Missing |
| AI_PUBLICATION_DRAFT_ASSISTANT | ❌ | Missing |

### §15 Interoperability — **CDS Hooks gap is real**

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_FHIR_MAPPING_ASSISTANT | ⚠️ | `fhirAdapter` exists; AI-assisted mapping doesn't |
| AI_FHIR_BUNDLE_GENERATOR | ⚠️ | FHIR routes exist; AI-assisted bundle generator doesn't |
| AI_FHIR_VALIDATION_ASSISTANT | ❌ | Missing |
| AI_ABDM_CARE_CONTEXT_ASSISTANT | ❌ | ABDM integration exists; AI-assisted care-context linking doesn't |
| AI_ABDM_RECORD_SUMMARY | ✅ | `abdm_longitudinal_risk` (close fit) |
| **AI_CDS_PATIENT_VIEW_CARD** | ❌ | **See S4** — `cdsEngine` returns alerts but not in CDS Hooks JSON spec |
| **AI_CDS_ORDER_SELECT_CARD** | ❌ | See S4 |
| **AI_CDS_ORDER_SIGN_CARD** | ❌ | See S4 |
| AI_EXTERNAL_EHR_IMPORT_ASSISTANT | ⚠️ | `documentIntelligenceService` partial |
| AI_HEALTH_RECORD_RECONCILIATION | ❌ | Missing |

### §16 Compliance / governance

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_AUDIT_LOG_SUMMARY | ⚠️ | `audit_logs` exists; no AI summary view |
| AI_SUSPICIOUS_ACCESS_DETECTION | ✅ | `cybersecurity_anomaly_detector` |
| AI_BREAK_GLASS_MONITOR | ✅ | Break-glass tables and routes |
| AI_PHI_LEAKAGE_DETECTOR | ✅ | `hallucinationDefenses.detectPhiLeaks` + `consent_phi_policy_sentinel` |
| AI_CONSENT_CHECK_ASSISTANT | ✅ | `consent_phi_policy_sentinel` |
| AI_MODEL_USAGE_LOGGER | ✅ | `clinical_ai_generations` + `clinical_ai_workflow_runs` |
| AI_HUMAN_REVIEW_WORKFLOW | ✅ | `clinical_ai_reviews` + `/clinical-ai/queue` |
| AI_AI_OUTPUT_CITATION_CHECKER | ✅ | `hallucinationDefenses` |
| AI_AI_UNCERTAINTY_CHECKER | ⚠️ | Temperature-per-risk; no explicit "I don't know" gate |
| AI_MODEL_REGISTRY | ✅ | `model_registry_workbench` |
| AI_PROMPT_VERSIONING | ✅ | `clinical_ai_prompts` + `promptExperimentService` |
| AI_EVALUATION_SUITE | ✅ | `clinical_ai_model_eval_runs` |
| AI_HALLUCINATION_DETECTION | ✅ | `hallucinationDefenses` |
| **AI_BIAS_MONITORING** | ❌ | **See S3** |
| AI_INCIDENT_REPORTING | ⚠️ | `rca_draft_generator` for clinical events; AI-incident-specific reporter absent |
| AI_MODEL_ROLLBACK | ✅ | `model_registry_workbench` stages |
| AI_FEATURE_FLAG_CONTROL | ✅ | `clinical_ai_modules.enabled` per tenant |
| AI_GOVERNANCE_DASHBOARD | ✅ | Admin overview UI |
| AI_REAL_WORLD_PERFORMANCE_MONITORING | ✅ | `driftCanaryService` |
| **AI_REGULATORY_READINESS_PACK** | ❌ | **See S5** |
| AI_POLICY_COMPLIANCE_CHECKER | ⚠️ | `policy_regulation_watcher` watches; doesn't gate features |

### §17 Voice / multimodal

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_VOICE_TO_NOTE | ✅ | `soap_from_dictation` |
| AI_VOICE_TO_PRESCRIPTION_DRAFT | ❌ | Missing |
| AI_PATIENT_VOICE_ASSISTANT | ✅ | `voice_patient_assistant_ivr` |
| AI_CALL_SUMMARY | ❌ | Missing |
| AI_WHATSAPP_ASSISTANT | ❌ | Missing |
| AI_IMAGE_DOCUMENT_EXTRACTION | ✅ | `documentOcrAdapter` |
| AI_HANDWRITTEN_NOTE_ASSISTANT | ❌ | Missing |
| AI_MULTIMODAL_PATIENT_CONTEXT | ✅ | `multimodal_patient_timeline` |

### §18 First-20 build order — score

| # | Feature | Status |
|---|---|---|
| 1 | AI_PATIENT_SUMMARY | ✅ |
| 2 | AI_VISIT_PREP_BRIEF | ✅ |
| 3 | AI_SOAP_NOTE_DRAFT | ✅ |
| 4 | AI_PATIENT_INSTRUCTIONS_DRAFT | ✅ |
| 5 | AI_REPORT_EXPLAINER | ❌ |
| 6 | AI_PRESCRIPTION_EXPLAINER | ❌ |
| 7 | AI_DISCHARGE_SUMMARY_DRAFT | ✅ |
| 8 | AI_DISCHARGE_MISSING_INFO_CHECK | ✅ |
| 9 | AI_LAB_RESULT_SUMMARY | ✅ |
| 10 | AI_LAB_TREND_SUMMARY | ⚠️ |
| 11 | AI_DOCUMENT_CLASSIFICATION | ✅ |
| 12 | AI_DOCUMENT_OCR | ✅ |
| 13 | AI_DOCUMENT_ENTITY_EXTRACTION | ✅ |
| 14 | AI_APPOINTMENT_ROUTER | ⚠️ |
| 15 | AI_NO_SHOW_PREDICTION | ✅ |
| 16 | AI_QUEUE_WAIT_TIME_PREDICTION | ⚠️ ED only |
| 17 | AI_DRUG_INTERACTION_CHECK | ✅ |
| 18 | AI_ALLERGY_CONFLICT_CHECK | ✅ |
| 19 | AI_MEDICATION_RECONCILIATION | ✅ |
| 20 | AI_MODEL_USAGE_LOGGER | ✅ |

**Score: 14/20 fully done · 3/20 partial · 3/20 missing.**

### §19 Human-approved-only enforcement — verified

The catalogue's list of 14 high-stakes modules mandating reviewer
sign-off — every one already routes through `clinical_ai_reviews` with
`requiresClinicianSignoff: true`, `requiresCitations: true`, and a
`reviewRoles[]` whitelist. Enforcement is consistent.

### §20 Avoid-initially list — verified

Every item the catalogue lists as "avoid" is already structurally
avoided by the architecture: no autonomous diagnosis, no autonomous
prescribing, no AI-only orders, no silent record edits, no patient-side
disease assertions, no draft commits without sign-off. The architecture
pivot ("rule-authoritative, AI-advisory") is the design.

---

## Prioritised build tiers

Ordered by user-visible value × low risk × leverage of existing
substrate. Within each tier, items are roughly equivalent — pick by
which one a customer is asking for.

### Tier A — fastest wins (substrate built; ship a module wrapper)

- AI_REPORT_EXPLAINER, AI_PRESCRIPTION_EXPLAINER (patient-facing) — same
  pattern as `patient_aftercare_instructions`, different content templates
- AI_LAB_PATIENT_EXPLANATION, AI_RADIOLOGY_PATIENT_EXPLANATION
- AI_LAB_TREND_SUMMARY (per-analyte)
- AI_DISCHARGE_MEDICATION_EXPLANATION (carve out from aftercare)
- AI_INVOICE_EXPLANATION
- AI_FRONT_DESK_ASSISTANT (text variant of the IVR)
- AI_PATIENT_FAQ_ASSISTANT (RAG against hospital-FAQ corpus)
- AI_AUDIT_LOG_SUMMARY (RAG against `audit_logs`)
- AI_CALL_SUMMARY
- AI_HANDWRITTEN_NOTE_ASSISTANT
- AI_VOICE_TO_PRESCRIPTION_DRAFT
- AI_LAB_PENDING_RESULT_REMINDER, AI_PENDING_REPORT_TRACKER

### Tier B — surgical / OR vertical (entire vertical missing)

- AI_PRE_OP_CHECKLIST_REVIEW
- AI_SURGICAL_CONSENT_DRAFT
- AI_OT_NOTE_DRAFT
- AI_POST_OP_INSTRUCTION_DRAFT
- AI_SURGICAL_RISK_SUMMARY
- AI_ANESTHESIA_PRECHECK_ASSISTANT
- AI_IMPLANT_CONSUMABLE_TRACKER
- AI_POST_OP_COMPLICATION_ALERT (specific to OR, not generic deterioration)

### Tier C — clinical assistants the catalogue flags as P0/P1

- AI_MEDICAL_CERTIFICATE_DRAFT, AI_CLINIC_LETTER_DRAFT
- AI_CLINICAL_NOTE_CLEANUP
- AI_MISSING_QUESTIONS / EXAMINATION / TESTS ASSISTANTs
- AI_ORDER_SET_SUGGESTION
- AI_RENAL_DOSE_CHECK, AI_LIVER_DOSE_CHECK, AI_PREGNANCY_LACTATION_WARNING (standalone)
- AI_ADVERSE_DRUG_EVENT_DETECTOR
- AI_FALL_RISK_PREDICTION, AI_PRESSURE_ULCER_RISK_PREDICTION, AI_AKI_RISK_ALERT
- AI_INTAKE_OUTPUT_SUMMARY
- AI_ICU_ROUND_SUMMARY (full version, not bundle audit)

### Tier D — emergency / triage vertical

- AI_EMERGENCY_TRIAGE_FORM_ASSISTANT
- AI_TRIAGE_PRIORITY_SUGGESTION (ESI / Manchester score)
- AI_RED_FLAG_DETECTION (ED first-contact, distinct from inpatient EWS)
- AI_EMERGENCY_SUMMARY, AI_AMBULANCE_HANDOVER_SUMMARY
- AI_STROKE_FAST_CHECK_ASSISTANT, AI_CHEST_PAIN_PROTOCOL_ASSISTANT
- AI_TRAUMA_CHECKLIST_ASSISTANT, AI_MLC_DOCUMENTATION_ASSISTANT

### Tier E — patient-facing engagement (mostly missing)

- AI_SYMPTOM_RED_FLAG_CHECKER (live)
- AI_CHRONIC_DISEASE_COACH (DM / HTN / CKD / cardiac / obstetric)
- AI_POST_DISCHARGE_CHECKIN_BOT, AI_POST_SURGERY_MONITORING_BOT
- AI_HOME_VITALS_INSIGHTS
- AI_DIET_ADVICE_DRAFT, AI_EXERCISE_ADVICE_DRAFT
- AI_MENTAL_HEALTH_SCREENING_BOT
- AI_MEDICATION_REMINDER_GENERATOR, AI_FOLLOW_UP_REMINDER_GENERATOR
- AI_PRE_VISIT_FORM_ASSISTANT
- AI_PREVENTIVE_HEALTH_RECOMMENDER, AI_FAMILY_HEALTH_RISK_SUMMARY

### Tier F — interoperability (specific, externally visible)

- **CDS Hooks adapter** (`patient-view`, `order-select`, `order-sign`) —
  single highest interop ROI; see S4
- AI_FHIR_VALIDATION_ASSISTANT
- AI_ABDM_CARE_CONTEXT_ASSISTANT
- AI_HEALTH_RECORD_RECONCILIATION
- AI_DOCUMENT_PATIENT_MATCHING (also a quality gap)
- AI_MEDICAL_RECORD_BUNDLE_GENERATOR (insurance / referral / ABDM packs)

### Tier G — public / population health (mostly-missing vertical)

- AI_CHRONIC_DISEASE_REGISTRY
- AI_SCREENING_GAP_DETECTION
- AI_HIGH_RISK_PATIENT_COHORTS (separate from trial matcher)
- AI_PUBLIC_HEALTH_REPORT_GENERATOR
- AI_DEIDENTIFICATION (general-purpose, not just synthetic-case)

### Tier H — operational forecasting tail

- AI_LAB_TAT_DELAY_PREDICTION, AI_RADIOLOGY_TAT_DELAY_PREDICTION
- AI_AMBULANCE_DEMAND_FORECAST
- AI_SMART_QUEUE_OPTIMIZATION (general, not just ED)
- AI_TARIFF_OPTIMIZATION_INSIGHTS
- AI_PACKAGE_COMPLIANCE_CHECK
- AI_PATIENT_FEEDBACK_SUMMARY, AI_SENTIMENT_ANALYSIS

---

## Recommendation

The catalogue is essentially a 250-feature wishlist on top of a
"rule-authoritative + decision-support-only + HITL" governance
substrate. **That substrate is at production grade.** What's missing is
breadth — about **65 of 250** features are absent as named modules, ~30
are partial, ~155 are present (counting both registered modules and
substrate-equivalents).

Don't add infrastructure; add module wrappers. Order:

1. Close the five substrate-level safety holes (S1–S5).
2. Tier A patient-facing explainers and Tier B OR vertical for highest
   visible value per week.
3. Then Tier C / D in parallel against customer pull.
4. Tiers E / F / G / H as the long tail.

---

## How to update this doc

- When a registered module ships covering a previously ❌ or ⚠️ entry,
  flip the status and link the module key.
- When a new substrate gap is discovered, add it as `S<N>` near the top
  with the same fix-scope structure.
- Keep the "Tiers" section roughly in sync with the section-by-section
  tables — items that flip to ✅ should be removed from their tier.
- This doc is the **module-level** catalogue audit. For
  entity / infra-level audit see `HEALTHCARE_AI_SPEC_AUDIT.md`. For the
  multi-agent rollout see `CLINICAL_AI_ROLLOUT_PLAN.md`.
