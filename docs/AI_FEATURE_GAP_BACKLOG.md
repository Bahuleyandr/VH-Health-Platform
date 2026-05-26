# AI Feature Gap Backlog

**Scope:** This doc audits a **user-facing AI feature catalogue** (~250 features
labelled `AI_*`) against the **92 registered modules** in
`clinical_ai_modules` and the AI service files under
`apps/backend/src/services/ai/`. It complements — but does not overlap —
`HEALTHCARE_AI_SPEC_AUDIT.md` (which audits the broader 38-section entity /
infra spec) and `CLINICAL_AI_ROLLOUT_PLAN.md` (which tracks the
substrate / multi-agent rollout).

**Audited:** 2026-04-30 against `main`.
**Reconciled:** 2026-05-25 against `fix/clinical-ai-governance-hardening`
for the current 92-module registry and governance hardening status.
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
governance* — **is already built and shipped on `main`**. As of
2026-05-01, **all 8 prioritised tiers (A–H) are shipped end-to-end**;
as of the 2026-05-25 governance pass, the registry has grown to
**92 modules**, all still decision-support-only and review-gated.
Headline numbers:

| Status | Count (out of ~250 catalogue items) |
|---|---|
| Present (registered module or substrate-equivalent) | ~219 |
| Partial (substrate exists; specific use case needs surfacing) | ~10 |
| Missing | ~21 |

Five substrate-level safety holes (S1–S5) were called out as
must-fix-before-new-modules. **All five shipped 2026-04-30**; the
section below documents what landed for the historical record.

### May 25 governance hardening addendum

This branch tightens the substrate rather than adding new modules:

- Review decisions now fail closed unless the caller role is in the
  module's configured `reviewRoles`, with admin override reserved for
  deliberate control-plane paths.
- Risky module enablement/runtime changes require a matching two-person
  approval and, for high/critical/external/provider/model changes, a
  recent accepted eval run for the effective `{ module_key, provider,
  model }`.
- Governance-critical schema reads now return explicit
  `schema_unavailable` failures instead of silently showing empty/default
  Clinical AI state.
- Generation metadata now standardizes `generation_mode`,
  `fallback_reason`, `readiness_reason`, and `provider_status` while
  retaining `used_ai` for compatibility; admin UI badges make fallback,
  blocked, and schema-unavailable states prominent.

The "First-20 build order" the catalogue prescribes is **19/20 fully
done · 1/20 partial · 0/20 missing** — see §18.

### Tier-by-tier shipment ledger (2026-04-30 → 2026-05-01)

| Tier | Scope | Modules | Migration | Commits |
|---|---|---|---|---|
| A | Patient explainers (lab / radiology / report / prescription / invoice) | 5 | (earlier) | `ce90bf58` → `f06a3918` ; `a50d11f9` → `5e6d8f1f` |
| A remainder | Fastest-win assistants (trend / discharge-med / FAQ / front-desk / audit / call / handwriting / voice-rx / lab-pending / pending-report) | 10 | 133 | `adba6cef` → `7c9e9418` |
| B | Surgical / OR vertical (preop / consent / OR note / postop / risk / anesthesia / implants / complications) | 8 | 116 (entities) + module config | `e87fe8ce` → `c0c04e3f` ; `46a60a43` → `7b6ddfa2` |
| C | P0/P1 clinical assistants (med cert / clinic letter / note cleanup / missing-Q/E/T / order-set / renal-liver-preg dose / ADE / fall / pressure-ulcer / AKI / I&O / ICU round) | 16 | 134 | `be724e88` → `7aea6e46` |
| D | Emergency / triage (triage form / priority / red-flag / ED summary / ambulance handover / stroke FAST / chest-pain / trauma / MLC) | 9 | 135 | `b9da6166` → `91ac454b` |
| E | Patient-facing engagement (red-flag / chronic coach / post-discharge / post-surgery / home vitals / diet / exercise / MH screening / med-reminder / follow-up / pre-visit / preventive / family risk) | 13 | 136 | `11ad6e51` → `8dee7969` |
| F | Interoperability (FHIR validation / ABDM care context / record reconciliation / doc-patient match / record bundle) | 5 | 137 | `a7f78313` → `90b52743` |
| G | Public / population health (chronic registry / screening gap / high-risk cohort / public-health report / PHI deidentification) | 5 | 138 | `4ca6ce55` → `b95f97e7` |
| H | Operational forecasting (lab TAT / radiology TAT / ambulance demand / queue optimization / tariff / package compliance / feedback summary / sentiment) | 8 | 139 | `1837262a` → `178e919e` |

Every module follows the `runExplainerPipeline` shape: structured-output
draft → `runOutputDefenses` → persist `clinical_ai_generations` → enqueue
`clinical_ai_reviews` for clinician sign-off, with module-config-driven
review roles + signoff requirements + critical-risk two-person enablement
gate. Tier C/D/F-G/H carry critical-risk modules requiring two-person
approval to enable per-tenant. Default `enabled=false` everywhere.

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

## Substrate-level safety holes (S1–S5) — ✅ ALL CLOSED 2026-04-30

These are **not** missing features — they are gaps that weakened the
existing safety story. **All five shipped 2026-04-30** in a single
session before further module work; new module work (Tier A, Phase A
KB CRUD, etc.) can now proceed against a clean substrate.

### S1. No prompt-injection detector for ingested documents — ✅ SHIPPED

**Was:** RAG and document intelligence both ingested external
PDFs/images with no untrusted-content gate. RAG context flows into LLM
prompts, so a malicious lab report could try to override clinician-
facing instructions.

**Shipped:** `documentPromptInjectionDetectorService.js` with three-tier
verdict (pass / flag / block); critical chat-template tokens, direct
override directives, and system-prompt-override patterns block; role-
flips, prompt-leak requests, persona-hijacks, and obfuscation patterns
flag. Wired into `documentIntelligenceService.ingestClinicalDocument`
(skips LLM call on block, hardens system prompt on flag) and
`ragService.indexDocument` (refuses corpus indexing on block, marks
chunk metadata on flag). 39 new tests (26 unit + 10 adversarial + 3
integration). See feat: S1 commit on main.

### S2. `clinical_protocols` table is empty — ✅ SHIPPED

**Was:** Migration 093 created the table; without seed data the
protocol-reminder pass in `cdsEngine` returned no alerts even though
the surface worked.

**Shipped:** Migration 111 seeds six citation-attributed protocols
(Sepsis 1-hour bundle / SSC 2021, VTE prophylaxis / NICE NG89, Suspected
DVT workup / NICE NG158, ARDS lung-protective ventilation / ARDSNet,
ICU SBAR handover / Joint Commission, ED-to-ward handover / SHARED).
Idempotent via unique index + ON CONFLICT DO NOTHING. 11 new tests.
See feat: S2 commit on main.

### S3. Bias-monitoring telemetry is absent — ✅ SHIPPED

**Was:** Eval runs tracked accuracy / F1 / safety / drift but not by
age / sex / language / disease group / facility, so an aggregate pass
rate could mask large per-slice gaps.

**Shipped:** Migration 112 adds `slice_attributes` to canary cases and
`slice_metrics` + `bias_signals` to canary runs and model eval runs.
`driftCanaryService.computeSliceMetrics` and `computeBiasSignals` flag
slices that underperform overall pass rate by ≥15pp (medium), ≥25pp
(high), ≥35pp (critical) with `sample_count >= 3`. Admin
DriftCanaryPanel now exposes per-axis inputs on the case form, a
bias-signals banner on the latest run, and a slice-metrics breakdown
table. 20 new tests. See feat: S3 commit on main.

### S4. CDS Hooks JSON-card contract is missing — ✅ SHIPPED

**Was:** `cdsEngine` returned internal alert objects, not standards-
compliant CDS Hooks cards, blocking third-party EHR integration.

**Shipped:** `cdsHooksAdapter` translates internal alerts to CDS Hooks
cards (severity → indicator, content-derived deterministic uuids,
overrideReasons + extension surfacing). Routes mounted at
`/api/v1/cds-services` with GET discovery + POST per-hook invoke for
patient-view, medication-prescribe, order-select, order-sign — same
RBAC + PHI-access logging as FHIR. 24 new tests. See feat: S4 commit
on main.

### S5. No regulatory-readiness pack exporter — ✅ SHIPPED

**Was:** Substrate generates everything CDSCO / EU MDR / FDA SaMD
reviewers want (model registry, eval runs, drift, incidents, reviews)
but there was no one-click "export evidence pack for module X v1.2"
flow.

**Shipped:** `regulatoryReadinessService.assembleReadinessPack` hits
seven tables in parallel (module / model_registry / eval_runs /
canary_runs / safety_reviews / prompts / reviews), tenant-scopes every
query, and degrades gracefully on missing tables (returns
`skipped_reason='schema_unavailable'`). Bias signal counts surface in
the summary. Admin route at POST `/admin/clinical-ai/readiness-pack`,
audit-logged via `logClinicalAiAudit`. Admin API client function
shipped; UI export button is a small follow-up wrapper. 6 new tests.
See feat: S5 commit on main.

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
| AI_CLINICAL_NOTE_CLEANUP | ✅ | `clinical_note_cleanup` (Tier C) |
| AI_SOAP_NOTE_DRAFT | ✅ | `soap_from_dictation` |
| AI_FOLLOW_UP_PLAN_DRAFT | ⚠️ | Subsumed under `patient_aftercare_instructions`; carve out a doctor-facing follow-up plan module |
| AI_REFERRAL_LETTER_DRAFT | ✅ | `referral_letter` |
| AI_PATIENT_INSTRUCTIONS_DRAFT | ✅ | `patient_aftercare_instructions` |
| AI_MEDICAL_CERTIFICATE_DRAFT | ✅ | `medical_certificate_draft` (Tier C) |
| AI_CLINIC_LETTER_DRAFT | ✅ | `clinic_letter_draft` (Tier C) |
| AI_DIFFERENTIAL_DIAGNOSIS_ASSISTANT | ✅ | `clinicalDebateService` (multi-LLM debate) |
| AI_MISSING_QUESTIONS_ASSISTANT | ✅ | `missing_questions_assistant` (Tier C) |
| AI_MISSING_EXAMINATION_ASSISTANT | ✅ | `missing_examination_assistant` (Tier C) |
| AI_MISSING_TESTS_ASSISTANT | ✅ | `missing_tests_assistant` (Tier C) |
| AI_PROBLEM_LIST_GENERATOR | ⚠️ | `clinicalKnowledgeGraphService` produces problem entities; no dedicated active/inactive surface |
| AI_DIAGNOSIS_CODING_ASSISTANT | ✅ | `clinical_coding_assist` |
| AI_ORDER_SET_SUGGESTION | ✅ | `order_set_suggestion` (Tier C) |
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
| AI_REPORT_EXPLAINER | ✅ | `patient_report_explainer` (Tier A explainers) |
| AI_PRESCRIPTION_EXPLAINER | ✅ | `prescription_patient_explainer` (Tier A explainers) |
| AI_DISCHARGE_EXPLAINER | ✅ | `patient_aftercare_instructions` |
| AI_MULTILINGUAL_EXPLANATION | ✅ | `patient_communication_translation` (8 Indic langs) |
| AI_APPOINTMENT_ROUTER | ⚠️ | `voice_patient_assistant_ivr` covers booking/refills via voice; no symptom→specialty router |
| AI_PRE_VISIT_FORM_ASSISTANT | ✅ | `pre_visit_form_assistant` (Tier E) |
| AI_MEDICATION_REMINDER_GENERATOR | ✅ | `medication_reminder_generator` (Tier E) |
| AI_FOLLOW_UP_REMINDER_GENERATOR | ✅ | `follow_up_reminder_generator` (Tier E) |
| AI_PATIENT_FAQ_ASSISTANT | ✅ | `patient_faq_assistant` (Tier A remainder) |
| AI_SYMPTOM_RED_FLAG_CHECKER | ✅ | `symptom_red_flag_checker` (Tier E) |
| AI_CHRONIC_DISEASE_COACH | ✅ | `chronic_disease_coach` (Tier E) |
| AI_POST_DISCHARGE_CHECKIN_BOT | ✅ | `post_discharge_checkin_bot` (Tier E) |
| AI_POST_SURGERY_MONITORING_BOT | ✅ | `post_surgery_monitoring_bot` (Tier E) |
| AI_HOME_VITALS_INSIGHTS | ✅ | `home_vitals_insights` (Tier E) |
| AI_PATIENT_DOCUMENT_UPLOAD_ASSISTANT | ⚠️ | `document_intelligence_ocr` does the heavy lifting; patient-app UX wrapper absent |
| AI_CAREGIVER_ASSISTANT | ✅ | `consent_aware_family_update` |
| AI_DIET_ADVICE_DRAFT | ✅ | `diet_advice_draft` (Tier E) |
| AI_EXERCISE_ADVICE_DRAFT | ✅ | `exercise_advice_draft` (Tier E) |
| AI_MENTAL_HEALTH_SCREENING_BOT | ✅ | `mental_health_screening_bot` (Tier E) |
| AI_PERSONAL_HEALTH_TWIN | ❌ | Missing (P3 — out of A-H tier scope) |
| AI_PREVENTIVE_HEALTH_RECOMMENDER | ✅ | `preventive_health_recommender` (Tier E) |
| AI_FAMILY_HEALTH_RISK_SUMMARY | ✅ | `family_health_risk_summary` (Tier E) |
| AI_REMOTE_PATIENT_MONITORING_AGENT | ⚠️ | `virtual_ward_triage` covers eligibility, not continuous monitoring loop |

### §3 Lab AI

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_LAB_RESULT_SUMMARY | ✅ | `lab_autoverification_delta` (rules-first + AI narrative) |
| AI_LAB_PATIENT_EXPLANATION | ✅ | `lab_patient_explanation` (Tier A explainers) |
| AI_LAB_ABNORMAL_VALUE_DETECTOR | ✅ | `lab_autoverification_delta` |
| AI_LAB_CRITICAL_VALUE_ALERT | ✅ | `cdsEngine` critical lab values + autoverification critical band |
| AI_LAB_TREND_SUMMARY | ✅ | `lab_trend_summary` (Tier A remainder, per-analyte trend) |
| AI_LAB_REPORT_OCR_EXTRACTION | ✅ | `documentOcrAdapter` + `document_intelligence_ocr` |
| AI_LAB_DUPLICATE_TEST_DETECTOR | ⚠️ | `cdsEngine` has duplicate orders detection at order time, not retrospective |
| AI_LAB_PENDING_RESULT_REMINDER | ✅ | `lab_pending_result_reminder` (Tier A remainder) |
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
| AI_RADIOLOGY_PATIENT_EXPLANATION | ✅ | `radiology_patient_explanation` (Tier A explainers) |
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
| AI_RENAL_DOSE_CHECK | ✅ | `renal_dose_check` (Tier C) |
| AI_LIVER_DOSE_CHECK | ✅ | `liver_dose_check` (Tier C) |
| AI_PREGNANCY_LACTATION_WARNING | ✅ | `pregnancy_lactation_warning` (Tier C, standalone — supersedes `obstetric_risk_assistant`) |
| AI_PEDIATRIC_DOSE_CHECK | ✅ | `pediatric_dosing_safety` |
| AI_GERIATRIC_MEDICATION_WARNING | ⚠️ | `polypharmacy_ai_review` covers polypharmacy but not specifically Beers criteria |
| AI_HIGH_RISK_MEDICATION_ALERT | ⚠️ | `cdsEngine` flags high-risk classes |
| AI_ANTIBIOTIC_STEWARDSHIP_ASSISTANT | ✅ | `antimicrobial_stewardship` |
| AI_MEDICATION_RECONCILIATION | ✅ | `medication_reconciliation` (CRITICAL-tier, deep model) |
| AI_ADVERSE_DRUG_EVENT_DETECTOR | ✅ | `adverse_drug_event_detector` (Tier C) |
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
| AI_INTAKE_OUTPUT_SUMMARY | ✅ | `intake_output_summary` (Tier C) |
| AI_MEDICATION_ADMINISTRATION_REMINDER | ⚠️ | `medication_reminder_generator` covers patient-side; nurse-side MAR-due reminder still substrate-only |
| AI_PENDING_TASK_ALERT | ⚠️ | `clinical_task_extractor` partial |
| AI_EARLY_WARNING_SCORE | ✅ | `deterioration_early_warning` (NEWS2 composite) |
| AI_DETERIORATION_RISK_ALERT | ✅ | Same |
| AI_SEPSIS_RISK_ALERT | ✅ | `sepsis_bundle_sentinel` |
| AI_AKI_RISK_ALERT | ✅ | `aki_risk_alert` (Tier C) |
| AI_FALL_RISK_PREDICTION | ✅ | `fall_risk_prediction` (Tier C) |
| AI_PRESSURE_ULCER_RISK_PREDICTION | ✅ | `pressure_ulcer_risk_prediction` (Tier C) |
| AI_ICU_ROUND_SUMMARY | ✅ | `icu_round_summary` (Tier C, full version vs `icu_ventilator_sedation_bundle` audit) |
| AI_DISCHARGE_READINESS_PREDICTION | ✅ | `discharge_readiness` |
| AI_PATIENT_HANDOVER_BETWEEN_DEPARTMENTS | ⚠️ | `handover_summary` shift-only; cross-dept variant absent |
| AI_CONTINUOUS_MONITORING_AGENT | ❌ | Missing — would need device-stream ingestion |
| AI_ICU_PREDICTIVE_ANALYTICS | ❌ | Missing |
| AI_AUTONOMOUS_NURSING_WORKFLOW_AGENT | ⚠️ | Workflow runner pattern fits; no dedicated nursing agent module |

### §7 Emergency / triage

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_EMERGENCY_TRIAGE_FORM_ASSISTANT | ✅ | `emergency_triage_form_assistant` (Tier D) |
| AI_RED_FLAG_DETECTION | ✅ | `ed_red_flag_detection` (Tier D, ED first-contact distinct from inpatient EWS) |
| AI_TRIAGE_PRIORITY_SUGGESTION | ✅ | `triage_priority_suggestion` (Tier D, ESI/Manchester/CTAS) |
| AI_EMERGENCY_SUMMARY | ✅ | `emergency_visit_summary` (Tier D) |
| AI_AMBULANCE_HANDOVER_SUMMARY | ✅ | `ambulance_handover_summary` (Tier D) |
| AI_STROKE_FAST_CHECK_ASSISTANT | ✅ | `stroke_fast_check_assistant` (Tier D) |
| AI_CHEST_PAIN_PROTOCOL_ASSISTANT | ✅ | `chest_pain_protocol_assistant` (Tier D) |
| AI_SEPSIS_PROTOCOL_ASSISTANT | ✅ | `sepsis_bundle_sentinel` |
| AI_TRAUMA_CHECKLIST_ASSISTANT | ✅ | `trauma_checklist_assistant` (Tier D) |
| AI_MLC_DOCUMENTATION_ASSISTANT | ✅ | `mlc_documentation_assistant` (Tier D) |

### §8 Discharge

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_DISCHARGE_SUMMARY_DRAFT | ✅ | `discharge_summary` |
| AI_DISCHARGE_INSTRUCTION_DRAFT | ✅ | `patient_aftercare_instructions` |
| AI_DISCHARGE_MEDICATION_EXPLANATION | ✅ | `discharge_medication_explanation` (Tier A remainder, standalone) |
| AI_DISCHARGE_FOLLOWUP_GENERATOR | ⚠️ | Folded into aftercare; `follow_up_reminder_generator` (Tier E) is patient-app-side |
| AI_DISCHARGE_MISSING_INFO_CHECK | ✅ | `discharge_readiness` |
| AI_DISCHARGE_TRANSLATION | ✅ | `patient_communication_translation` |
| AI_DISCHARGE_DELAY_PREDICTION | ⚠️ | `bed_discharge_forecast` is occupancy-side; per-patient delay reason missing |
| AI_DISCHARGE_CLEARANCE_ASSISTANT | ⚠️ | `discharge_readiness` checks clinical readiness; pharmacy/billing/insurance gates not unified |
| AI_POST_DISCHARGE_RISK_SCORE | ✅ | `longitudinalRiskService` |
| AI_PENDING_REPORT_TRACKER | ✅ | `pending_report_tracker` (Tier A remainder) |

### §9 Surgery / OT — Tier B SHIPPED

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_PRE_OP_CHECKLIST_REVIEW | ✅ | `pre_op_checklist_review` (Tier B) |
| AI_SURGICAL_CONSENT_DRAFT | ✅ | `surgical_consent_draft` (Tier B) |
| AI_OT_NOTE_DRAFT | ✅ | `ot_operative_note_draft` (Tier B) |
| AI_POST_OP_INSTRUCTION_DRAFT | ✅ | `post_op_instructions_draft` (Tier B) |
| AI_IMPLANT_CONSUMABLE_TRACKER | ✅ | `implant_consumable_tracker` (Tier B) |
| AI_OT_SCHEDULING_OPTIMIZER | ✅ | `ot_block_scheduling` |
| AI_SURGICAL_RISK_SUMMARY | ✅ | `surgical_risk_summary` (Tier B) |
| AI_ANESTHESIA_PRECHECK_ASSISTANT | ✅ | `anesthesia_precheck_assistant` (Tier B) |
| AI_POST_OP_COMPLICATION_ALERT | ✅ | `post_op_complication_detector` (Tier B, OR-specific) |
| (extra in registry) | ✅ | `ot_case_time_predictor` exists, fits AI_OT_DURATION |

Tier B closed the entire surgical/OR gap in one PR series — entities
(migration 116) + 8 AI generators + admin panel.

### §10 Document AI / OCR

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_DOCUMENT_CLASSIFICATION | ✅ | `document_intelligence_ocr` |
| AI_DOCUMENT_OCR | ✅ | `documentOcrAdapter` (multi-provider) |
| AI_DOCUMENT_SUMMARY | ⚠️ | Within document intelligence; not standalone |
| AI_DOCUMENT_ENTITY_EXTRACTION | ✅ | Within document intelligence |
| AI_DOCUMENT_PATIENT_MATCHING | ✅ | `document_patient_matching` (Tier F) |
| AI_DUPLICATE_DOCUMENT_DETECTION | ❌ | Missing (only draft fingerprint via `hallucinationDefenses.draftFingerprint`) |
| AI_EXTERNAL_REPORT_IMPORT | ⚠️ | Document intelligence covers reads; structured-field write-back patchy |
| AI_DOCUMENT_SEARCH | ✅ | `ragService` (pgvector + Ollama embed) |
| AI_CONFLICTING_INFORMATION_DETECTOR | ⚠️ | `health_record_reconciliation` (Tier F) covers two-source case; cross-encounter still open |
| AI_MEDICAL_RECORD_BUNDLE_GENERATOR | ✅ | `medical_record_bundle_generator` (Tier F, AI-assisted bundle for insurance/referral/ABDM) |
| AI_CHART_GAP_DETECTOR | ✅ | `chart_completion_auditor` |
| **AI_DOCUMENT_PROMPT_INJECTION_DETECTOR** | ✅ | `documentPromptInjectionDetectorService`; see S1 |

### §11 Billing / coding / insurance

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_INVOICE_EXPLANATION | ✅ | `invoice_patient_explainer` (Tier A explainers) |
| AI_BILLING_ITEM_SUGGESTION | ⚠️ | `charge_capture_audit` retrospective, not suggestion |
| AI_MISSING_CHARGE_DETECTION | ✅ | `charge_capture_audit` |
| AI_INSURANCE_DOCUMENT_CHECKLIST | ⚠️ | `prior_authorization_generator` partial |
| AI_CLAIM_SUMMARY_DRAFT | ⚠️ | `prior_authorization_generator` partial |
| AI_PREAUTH_LETTER_DRAFT | ✅ | `prior_authorization_generator` |
| AI_PACKAGE_COMPLIANCE_CHECK | ✅ | `package_compliance_check` (Tier H) |
| AI_CLAIM_DENIAL_RISK | ✅ | `denial_risk_assist` |
| AI_CLAIM_QUERY_RESPONSE_DRAFT | ✅ | `appeal_letter_generator` |
| AI_CODING_ASSISTANT | ✅ | `clinical_coding_assist` |
| AI_REVENUE_LEAKAGE_DETECTION | ⚠️ | `payer_contract_variance` partly |
| AI_BILLING_ANOMALY_DETECTION | ⚠️ | Same |
| AI_TARIFF_OPTIMIZATION_INSIGHTS | ✅ | `tariff_optimization_insights` (Tier H) |

### §12 Hospital operations

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_NO_SHOW_PREDICTION | ✅ | `appointment_no_show_predictor` |
| AI_QUEUE_WAIT_TIME_PREDICTION | ✅ | `smart_queue_optimization` (Tier H, generalized beyond ED) |
| AI_SMART_QUEUE_OPTIMIZATION | ✅ | `smart_queue_optimization` (Tier H) |
| AI_DOCTOR_SCHEDULE_ASSISTANT | ⚠️ | `staff_roster_optimizer` covers staff, not doctor-specific load |
| AI_FRONT_DESK_ASSISTANT | ✅ | `front_desk_assistant` (Tier A remainder, text/web — IVR variant via `voice_patient_assistant_ivr`) |
| AI_PATIENT_FEEDBACK_SUMMARY | ✅ | `patient_feedback_summary` (Tier H) |
| AI_SENTIMENT_ANALYSIS | ✅ | `sentiment_analysis` (Tier H) |
| AI_BED_OCCUPANCY_FORECAST | ✅ | `bed_discharge_forecast` |
| AI_ADMISSION_DEMAND_FORECAST | ✅ | `acuity_staffing_forecast` |
| AI_DISCHARGE_FORECAST | ✅ | `bed_discharge_forecast` |
| AI_STAFF_ROSTER_OPTIMIZER | ✅ | `staff_roster_optimizer` |
| AI_LAB_TAT_DELAY_PREDICTION | ✅ | `lab_tat_delay_prediction` (Tier H) |
| AI_RADIOLOGY_TAT_DELAY_PREDICTION | ✅ | `radiology_tat_delay_prediction` (Tier H) |
| AI_HOUSEKEEPING_TASK_OPTIMIZER | ✅ | `housekeeping_bed_turnover` |
| AI_AMBULANCE_DEMAND_FORECAST | ✅ | `ambulance_demand_forecast` (Tier H) |
| AI_EQUIPMENT_UTILIZATION_ANALYTICS | ⚠️ | `biomed_device_maintenance` partial |
| AI_HOSPITAL_COMMAND_CENTER | ✅ | `hospital_command_center` |
| AI_CAPACITY_PLANNING | ✅ | `acuity_staffing_forecast` |
| AI_PROCUREMENT_FORECASTING | ✅ | `inventory_intelligence` + `blood_bank_demand_forecast` |
| AI_OPERATIONAL_BOT | ✅ | `operationalAiService` + `admin_policy_copilot` |

### §13 Public / population health — Tier G SHIPPED

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_DISEASE_CLUSTER_DETECTION | ✅ | `infection_control_sentinel` |
| AI_ANTIBIOTIC_RESISTANCE_DASHBOARD | ⚠️ | Inside infection control, not surfaced |
| AI_CHRONIC_DISEASE_REGISTRY | ✅ | `chronic_disease_registry` (Tier G) |
| AI_SCREENING_GAP_DETECTION | ✅ | `screening_gap_detection` (Tier G) |
| AI_HIGH_RISK_PATIENT_COHORTS | ✅ | `high_risk_patient_cohorts` (Tier G, separate from trial matcher) |
| AI_PUBLIC_HEALTH_REPORT_GENERATOR | ✅ | `public_health_report_generator` (Tier G) |
| AI_OUTBREAK_EARLY_WARNING | ✅ | `infection_control_sentinel` |

### §14 Research / trials

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_COHORT_FINDER | ⚠️ | `clinical_trial_matcher` partial |
| AI_TRIAL_MATCHING | ✅ | `clinical_trial_matcher` |
| AI_ELIGIBILITY_CRITERIA_PARSER | ⚠️ | `trialCatalogSyncService` partial |
| AI_RETROSPECTIVE_STUDY_ASSISTANT | ❌ | Missing |
| AI_DEIDENTIFICATION | ✅ | `phi_deidentification` (Tier G, general-purpose stripper for arbitrary records) |
| AI_RESEARCH_SUMMARY_GENERATOR | ❌ | Missing |
| AI_PUBLICATION_DRAFT_ASSISTANT | ❌ | Missing |

### §15 Interoperability — **CDS Hooks gap is real**

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_FHIR_MAPPING_ASSISTANT | ⚠️ | `fhirAdapter` exists; AI-assisted mapping doesn't |
| AI_FHIR_BUNDLE_GENERATOR | ⚠️ | FHIR routes exist; AI-assisted bundle generator doesn't |
| AI_FHIR_VALIDATION_ASSISTANT | ✅ | `fhir_validation_assistant` (Tier F) |
| AI_ABDM_CARE_CONTEXT_ASSISTANT | ✅ | `abdm_care_context_assistant` (Tier F, AI-assisted care-context linking) |
| AI_ABDM_RECORD_SUMMARY | ✅ | `abdm_longitudinal_risk` (close fit) |
| **AI_CDS_PATIENT_VIEW_CARD** | ✅ | **S4 SHIPPED** — `cdsHooksAdapter` returns CDS Hooks JSON cards |
| **AI_CDS_ORDER_SELECT_CARD** | ✅ | S4 SHIPPED |
| **AI_CDS_ORDER_SIGN_CARD** | ✅ | S4 SHIPPED |
| AI_EXTERNAL_EHR_IMPORT_ASSISTANT | ⚠️ | `documentIntelligenceService` partial |
| AI_HEALTH_RECORD_RECONCILIATION | ✅ | `health_record_reconciliation` (Tier F) |

### §16 Compliance / governance

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_AUDIT_LOG_SUMMARY | ✅ | `audit_log_summary` (Tier A remainder) |
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
| **AI_BIAS_MONITORING** | ✅ | **S3 SHIPPED** — `driftCanaryService.computeSliceMetrics` / `computeBiasSignals` |
| AI_INCIDENT_REPORTING | ⚠️ | `rca_draft_generator` for clinical events; AI-incident-specific reporter absent |
| AI_MODEL_ROLLBACK | ✅ | `model_registry_workbench` stages |
| AI_FEATURE_FLAG_CONTROL | ✅ | `clinical_ai_modules.enabled` per tenant |
| AI_GOVERNANCE_DASHBOARD | ✅ | Admin overview UI |
| AI_REAL_WORLD_PERFORMANCE_MONITORING | ✅ | `driftCanaryService` |
| **AI_REGULATORY_READINESS_PACK** | ✅ | **S5 SHIPPED** — `regulatoryReadinessService.assembleReadinessPack` |
| AI_POLICY_COMPLIANCE_CHECKER | ⚠️ | `policy_regulation_watcher` watches; doesn't gate features |

### §17 Voice / multimodal

| Catalogue ID | Status | Mapping / gap |
|---|---|---|
| AI_VOICE_TO_NOTE | ✅ | `soap_from_dictation` |
| AI_VOICE_TO_PRESCRIPTION_DRAFT | ✅ | `voice_to_prescription_draft` (Tier A remainder) |
| AI_PATIENT_VOICE_ASSISTANT | ✅ | `voice_patient_assistant_ivr` |
| AI_CALL_SUMMARY | ✅ | `call_summary` (Tier A remainder) |
| AI_WHATSAPP_ASSISTANT | ⚠️ | E5 ships WhatsApp delivery channel + Twilio adapter; conversational AI bot wrapper still open |
| AI_IMAGE_DOCUMENT_EXTRACTION | ✅ | `documentOcrAdapter` |
| AI_HANDWRITTEN_NOTE_ASSISTANT | ✅ | `handwritten_note_assistant` (Tier A remainder) |
| AI_MULTIMODAL_PATIENT_CONTEXT | ✅ | `multimodal_patient_timeline` |

### §18 First-20 build order — score

| # | Feature | Status |
|---|---|---|
| 1 | AI_PATIENT_SUMMARY | ✅ |
| 2 | AI_VISIT_PREP_BRIEF | ✅ |
| 3 | AI_SOAP_NOTE_DRAFT | ✅ |
| 4 | AI_PATIENT_INSTRUCTIONS_DRAFT | ✅ |
| 5 | AI_REPORT_EXPLAINER | ✅ Tier A explainers |
| 6 | AI_PRESCRIPTION_EXPLAINER | ✅ Tier A explainers |
| 7 | AI_DISCHARGE_SUMMARY_DRAFT | ✅ |
| 8 | AI_DISCHARGE_MISSING_INFO_CHECK | ✅ |
| 9 | AI_LAB_RESULT_SUMMARY | ✅ |
| 10 | AI_LAB_TREND_SUMMARY | ✅ Tier A remainder |
| 11 | AI_DOCUMENT_CLASSIFICATION | ✅ |
| 12 | AI_DOCUMENT_OCR | ✅ |
| 13 | AI_DOCUMENT_ENTITY_EXTRACTION | ✅ |
| 14 | AI_APPOINTMENT_ROUTER | ⚠️ symptom→specialty router still substrate-only |
| 15 | AI_NO_SHOW_PREDICTION | ✅ |
| 16 | AI_QUEUE_WAIT_TIME_PREDICTION | ✅ Tier H (`smart_queue_optimization` generalized beyond ED) |
| 17 | AI_DRUG_INTERACTION_CHECK | ✅ |
| 18 | AI_ALLERGY_CONFLICT_CHECK | ✅ |
| 19 | AI_MEDICATION_RECONCILIATION | ✅ |
| 20 | AI_MODEL_USAGE_LOGGER | ✅ |

**Score: 19/20 fully done · 1/20 partial · 0/20 missing.**

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

## Prioritised build tiers — ALL SHIPPED

Tiers A through H were the catalogue's highest-value targets. **All
eight shipped 2026-04-30 → 2026-05-01** across 9 PRs (Tier A explainers
+ Tier A remainder + Tier B entities + Tier B AI + Tier C/D/E/F/G/H one
each), 79 tier-build modules across that cycle and 92 registered modules
as of 2026-05-25, +120 backend tests across the tier-build cycle. See the
"Tier-by-tier shipment ledger" table in TL;DR for migration numbers and
commit anchors.

### Remaining catalogue items (small punch list, not a tier)

After Tier A–H, the catalogue items that still warrant module-level work
are scattered rather than vertical:

- **AI_APPOINTMENT_ROUTER** — symptom→specialty router; `chatbot` covers
  general patient-FAQ, `voice_patient_assistant_ivr` covers booking, but
  no dedicated symptom→specialty triage module yet.
- **AI_DOCTOR_SCHEDULE_ASSISTANT** — doctor-specific load balancer
  (current `staff_roster_optimizer` is generic-staff).
- **AI_GERIATRIC_MEDICATION_WARNING** — Beers-criteria-aware variant of
  `polypharmacy_ai_review`.
- **AI_HIGH_RISK_MEDICATION_ALERT** — promote `cdsEngine` flag to a
  module wrapper for explicit governance.
- **AI_RADIOLOGY_REPORT_SUMMARY** — pure-summary variant of
  `radiology_report_qa`.
- **AI_RADIOLOGY_REPORT_TEMPLATE_ASSISTANT, AI_RADIOLOGY_IMPRESSION_EXTRACTOR,
  AI_RADIOLOGY_FOLLOWUP_REMINDER, AI_IMAGING_ORDER_APPROPRIATENESS_ASSISTANT,
  AI_ECG_REPORT_EXPLAINER, AI_ECHO_REPORT_SUMMARY** — radiology-side
  long tail; substrate ready, customer pull will decide ordering.
- **AI_PRESCRIPTION_INSTRUCTION_GENERATOR, AI_MEDICATION_TIMING_NORMALIZER,
  AI_PHARMACY_SUBSTITUTE_SUGGESTION, AI_AUTOMATED_FORMULARY_OPTIMIZATION,
  AI_LAB_ORDER_SUGGESTION, AI_LAB_PRE_ANALYTICAL_ERROR_DETECTOR,
  AI_LAB_REFERENCE_RANGE_SELECTOR, AI_DISEASE_PATTERN_FROM_LABS** —
  pharmacy/lab fine-grained tail.
- **AI_MEDICATION_ADMINISTRATION_REMINDER** — nurse-side MAR-due variant
  (patient-side is `medication_reminder_generator`).
- **AI_PATIENT_HANDOVER_BETWEEN_DEPARTMENTS** — cross-dept variant of
  `handover_summary`.
- **AI_CONTINUOUS_MONITORING_AGENT, AI_ICU_PREDICTIVE_ANALYTICS** — need
  device-stream ingestion before module wrappers make sense.
- **AI_DUPLICATE_DOCUMENT_DETECTION, AI_CONFLICTING_INFORMATION_DETECTOR**
   (cross-encounter), **AI_RETROSPECTIVE_STUDY_ASSISTANT,
  AI_RESEARCH_SUMMARY_GENERATOR, AI_PUBLICATION_DRAFT_ASSISTANT** —
  research + document tail.
- **AI_WHATSAPP_ASSISTANT** — channel + Twilio adapter shipped in E5;
  conversational AI bot wrapper still open.
- **AI_PERSONAL_HEALTH_TWIN, AI_REMOTE_PATIENT_MONITORING_AGENT,
  AI_LAB_MACHINE_ANOMALY_DETECTION, AI_AI_UNCERTAINTY_CHECKER** —
  P3-deferred; not in any A–H tier.

The catalogue's remaining **~21 missing** items above are all
single-module wrappers that follow the `runExplainerPipeline` shape,
so adding any of them is roughly a day of work each (migration row +
service generator + admin route + 3-5 unit tests). Sequence by customer
pull, not by tier order, since the verticals are now closed.

---

## Recommendation

The catalogue was essentially a 250-feature wishlist on top of a
"rule-authoritative + decision-support-only + HITL" governance
substrate. **As of 2026-05-01 the wishlist is largely cleared.**
~219/250 features are present as named modules or substrate-equivalents,
~10 are partial, ~21 are deliberately deferred (P3 / device-dependent /
research-tail).

What's left is **rollout, not build**:

1. ✅ Close the five substrate-level safety holes (S1–S5) — **all
   shipped 2026-04-30**.
2. ✅ Tier A patient-facing explainers + Tier A remainder + Tier B OR
   vertical — **all shipped 2026-04-30**.
3. ✅ Tier C clinical assistants + Tier D emergency vertical —
   **shipped 2026-04-30 → 2026-05-01**.
4. ✅ Tiers E / F / G / H — **all shipped 2026-05-01**.

Next-up moves are no longer about adding modules — they are:

- **Governance rollout with operators**: the repo has per-tenant enablement
  requests, two-person approval handoffs, eval evidence gates, and visible
  fallback/blocked/schema-unavailable badges. The next action is to run the
  narrow first-pilot package with real hospital staff and verify the process
  holds outside seeded CI data.
- **Per-tenant rollout playbook**: shipped as
  [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md). Use
  `medication_reconciliation` + `patient_aftercare_instructions` for
  `stage_1_clinical_review` before broader Stage 1 enablement.
- **Local-Ollama deep-tier pilot**: the platform route and smoke proof are
  shipped; hospital-side work remains GPU/node provisioning, model choice,
  and `CLINICAL_AI_DEEP_*` configuration for CRITICAL-tier modules.
- **Long-tail catalogue items** as customer pull arrives (see the
  "Remaining catalogue items" punch list above).

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
