# Clinical AI Module Inventory — VH Health Platform

> **Generated:** 2026-06-16 · **Source of truth:** `apps/backend/src/services/ai/clinicalAiModuleService.js` (`CLINICAL_AI_MODULES`) · **Repo commit:** `26341945`
> Machine-generated (registry metadata + a `git grep` wiring scan). Refresh with `node apps/backend/scripts/gen-ai-module-inventory.mjs`. Do not hand-edit the tables.

## Summary

| Metric | Count |
|---|---:|
| **Total governed modules** | 99 |
| Enabled by default (seed) | 4 |
| Require clinician sign-off | 57 |
| Deep-tier (need GPU+Ollama for full quality) | 12 |
| Patient-facing (OFF by policy) | 13 |
| Declare curated-KB grounding | 5 |
| **Key-referenced by a service** | 99 |
| **Key-referenced by a route** | 14 |
| **Key-referenced by a test** | 81 |
| **Flagged — no service/route ref by key (verify)** | 0 |
| **Reaches the CDS dashboard (cds_alerts)** | 11 |
| **CDS-surfacing gaps (serious bedside, not on dashboard)** | 32 |

## Wiring verification (code-grounded)

A `git grep` of each `module_key` over `apps/backend/src`: **99/99** are referenced by a service and **14/99** by a route. This replaces the old hand-asserted "everything is wired" claim with a machine-checked signal.

_Every module_key is referenced by at least one service or route in the source._

## CDS dashboard surfacing

Only **11/99** modules write to `cds_alerts` (the clinician's patient-view / encounter-start cards). The rest persist to a review queue / their own table — fine for back-office review, but a *serious bedside risk* that never reaches the dashboard is a safety gap (the NEWS2 / D26 pregnancy-BP class).

**32 high/critical-risk bedside module(s) have a producing service but do NOT reach the CDS dashboard** — surfacing candidates (wire `raiseCdsAlert` for the serious-severity path, as done for polypharmacy / antimicrobial stewardship). Verify each (the key-grep can't see a differently-named surfacing service):

| Module | key | Surface | Risk |
|---|---|---|---|
| Discharge Package Compose | `discharge_summary_compose` | emr | high |
| Patient Record Summary | `patient_record_summary` | emr | high |
| OP Visit Prep | `op_visit_prep` | opd | high |
| OP Investigation Review Aid | `op_investigation_review` | opd | high |
| OP Differential and Red Flag Aid | `op_differential_red_flags` | opd | critical |
| Clinical Task Extractor | `clinical_task_extractor` | clinical_operations | high |
| Daily Ward Round Brief | `daily_ward_round_brief` | ward | high |
| Blood Bank Demand and Compatibility Forecast | `blood_bank_demand_forecast` | blood_bank | high |
| Cybersecurity / Medical Device Anomaly Detector | `cybersecurity_anomaly_detector` | security | high |
| Pharmacogenomics / PGx Support | `pharmacogenomics_support` | pharmacy | high |
| Generalized Pathway Bundle Compliance | `pathway_bundle_compliance` | clinical | high |
| Radiology Report QA / Discrepancy Assistant | `radiology_report_qa` | radiology | high |
| ED Triage and Boarding Predictor | `ed_triage_boarding_predictor` | emergency | high |
| Pediatric Dosing Safety AI | `pediatric_dosing_safety` | pharmacy | critical |
| Lab Autoverification / Delta Check Assistant | `lab_autoverification_delta` | lab | high |
| Nursing Ambient Documentation | `nursing_ambient_documentation` | clinical | high |
| Discharge Readiness | `discharge_readiness` | emr | high |
| Abnormal Result Triage | `abnormal_result_triage` | clinical | critical |
| Quality Case Review | `quality_case_review` | quality | high |
| SOAP from Dictation | `soap_from_dictation` | clinical | high |
| Radiology AI Interpretation | `radiology_ai_interpretation` | radiology | critical |
| Document Intelligence / OCR | `document_intelligence_ocr` | medical_records | high |
| Chart Completion Auditor | `chart_completion_auditor` | medical_records | high |
| Ambient Visit Documentation | `ambient_visit_documentation` | clinical | high |
| Pre-Op Checklist Review | `preop_checklist_review` | theatre | critical |
| Surgical Consent Draft | `surgical_consent_draft` | theatre | high |
| Operative Note Draft | `ot_note_draft` | theatre | high |
| Surgical Risk Summary | `surgical_risk_summary` | theatre | critical |
| Anesthesia Pre-Check Assistant | `anesthesia_precheck_assistant` | theatre | critical |
| Implant + Consumable Tracker | `implant_consumable_tracker` | theatre | high |
| Post-Op Complication Alert | `post_op_complication_alert` | theatre | critical |
| Teleconsult Note Draft | `teleconsult_note_draft` | telemedicine | high |

### Enabled by default (seed)

The only modules ON for a freshly-migrated tenant. Everything else is opt-in per tenant via `clinical_ai_tenant_modules`.

| Module | key | Surface | Risk |
|---|---|---|---|
| Discharge Summary Drafts | `discharge_summary` | emr | high |
| Nursing Handover Drafts | `handover_summary` | clinical | medium |
| AI ROI Dashboard | `ai_roi_dashboard` | governance | low |
| AI Safety Reviewer | `ai_safety_reviewer` | governance | high |

### Deep-tier modules (12)

Route to the deep model tier when `CLINICAL_AI_DEEP_*` + an Ollama GPU node are configured. **Until then they fall back to a deterministic template** (recorded as `generation_mode: template_fallback`, but not gated) — confirm `used_ai:true` with an operator smoke-gen before enabling any of these.

| Module | key | Surface | Default ON |
|---|---|---|---|
| Discharge Summary Drafts | `discharge_summary` | emr | ✅ |
| OP Differential and Red Flag Aid | `op_differential_red_flags` | opd | — |
| Medication Reconciliation | `medication_reconciliation` | pharmacy | — |
| Pregnancy / Obstetric Risk Assistant | `obstetric_risk_assistant` | obstetrics | — |
| Abnormal Result Triage | `abnormal_result_triage` | clinical | — |
| Pre-Op Checklist Review | `preop_checklist_review` | theatre | — |
| Surgical Consent Draft | `surgical_consent_draft` | theatre | — |
| Operative Note Draft | `ot_note_draft` | theatre | — |
| Surgical Risk Summary | `surgical_risk_summary` | theatre | — |
| Anesthesia Pre-Check Assistant | `anesthesia_precheck_assistant` | theatre | — |
| Post-Op Complication Alert | `post_op_complication_alert` | theatre | — |
| Teleconsult Note Draft | `teleconsult_note_draft` | telemedicine | — |

### Curated-KB-grounded modules (5)

Pull curation-approved formulary/antibiogram/protocol chunks into the prompt (gated by `settings.knowledgeBases`; grounds via the admission workflow graph, the shared `runExplainerPipeline`, or a direct service call). Grounding no-ops gracefully until the embedder (`CLINICAL_AI_EMBED_URL` + `nomic-embed-text`) and **approved** KB content exist.

| Module | key | Knowledge bases |
|---|---|---|
| OP Investigation Review Aid | `op_investigation_review` | clinical_guideline, sop |
| OP Follow-Up Plan Draft | `op_follow_up_plan` | clinical_guideline, sop |
| Medication Reconciliation | `medication_reconciliation` | formulary, clinical_guideline |
| Antimicrobial Stewardship Assistant | `antimicrobial_stewardship` | antibiotic_policy, clinical_guideline, formulary |
| Generalized Pathway Bundle Compliance | `pathway_bundle_compliance` | clinical_guideline, sop |

### Patient-facing modules (13) — OFF by policy

Built and governed, but deliberately kept off until a decision to go patient-facing.

| Module | key | Surface |
|---|---|---|
| Patient Aftercare Instructions | `patient_aftercare_instructions` | patient |
| Voice Patient Assistant / IVR | `voice_patient_assistant_ivr` | patient_communication |
| Consent-Aware Family Update Generator | `consent_aware_family_update` | patient |
| Patient Teach-Back / Comprehension AI | `patient_teach_back_comprehension` | patient |
| Patient Communication Translation | `patient_communication_translation` | patient |
| Patient Record Chatbot | `patient_record_chatbot` | patient |
| Virtual Ward Triage | `virtual_ward_triage` | virtual_ward |
| Lab Result Patient Explanation | `lab_patient_explanation` | patient |
| Radiology Patient Explanation | `radiology_patient_explanation` | patient |
| Generic Patient Report Explainer | `patient_report_explainer` | patient |
| Prescription Patient Explainer | `prescription_patient_explainer` | patient |
| Invoice Patient Explainer | `invoice_patient_explainer` | patient |
| Post-Op Instruction Draft | `post_op_instruction_draft` | patient |

## Full module register (99)

Sorted: enabled first, then by surface. **Default** = seed default (per-tenant override wins at runtime). **Svc/Route/Test** = the module_key is referenced by a service / route / test file (code-grounded `git grep`; a `—` may still be wired via a differently-named service). **CDS** = a source file referencing the module writes to `cds_alerts` (reaches the clinician dashboard). **Deep** = needs GPU tier. **Pt** = patient-facing. **KB** = declares curated-KB grounding.

| # | Module | key | Surface | Default | Risk | Svc | Route | Test | CDS | Deep | Pt | KB |
|---:|---|---|---|:---:|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | Nursing Handover Drafts | `handover_summary` | clinical | ✅ | medium | ✅ | — | ✅ | — | — | — | — |
| 2 | Discharge Summary Drafts | `discharge_summary` | emr | ✅ | high | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| 3 | AI ROI Dashboard | `ai_roi_dashboard` | governance | ✅ | low | ✅ | — | — | — | — | — | — |
| 4 | AI Safety Reviewer | `ai_safety_reviewer` | governance | ✅ | high | ✅ | — | — | — | — | — | — |
| 5 | Denial Risk Assist | `denial_risk_assist` | billing | — | medium | ✅ | — | ✅ | — | — | — | — |
| 6 | Biomedical Device Maintenance Predictor | `biomed_device_maintenance` | biomedical | — | medium | ✅ | — | ✅ | — | — | — | — |
| 7 | Blood Bank Demand and Compatibility Forecast | `blood_bank_demand_forecast` | blood_bank | — | high | ✅ | — | ✅ | — | — | — | — |
| 8 | Abnormal Result Triage | `abnormal_result_triage` | clinical | — | critical | ✅ | ✅ | ✅ | — | ✅ | — | — |
| 9 | Ambient Visit Documentation | `ambient_visit_documentation` | clinical | — | high | ✅ | — | — | — | — | — | — |
| 10 | Clinician EHR Query | `clinician_ehr_query` | clinical | — | medium | ✅ | ✅ | ✅ | — | — | — | — |
| 11 | Deterioration Early Warning | `deterioration_early_warning` | clinical | — | critical | ✅ | — | ✅ | ✅ | — | — | — |
| 12 | Generalized Pathway Bundle Compliance | `pathway_bundle_compliance` | clinical | — | high | ✅ | — | ✅ | — | — | — | ✅ |
| 13 | Nursing Ambient Documentation | `nursing_ambient_documentation` | clinical | — | high | ✅ | — | ✅ | — | — | — | — |
| 14 | SOAP from Dictation | `soap_from_dictation` | clinical | — | high | ✅ | — | ✅ | — | — | — | — |
| 15 | Clinical Task Extractor | `clinical_task_extractor` | clinical_operations | — | high | ✅ | — | ✅ | — | — | — | — |
| 16 | Sepsis Bundle Sentinel | `sepsis_bundle_sentinel` | clinical_safety | — | critical | ✅ | — | ✅ | ✅ | — | — | — |
| 17 | Training and Simulation Coach | `training_simulation_coach` | education | — | medium | ✅ | — | ✅ | — | — | — | — |
| 18 | ED Triage and Boarding Predictor | `ed_triage_boarding_predictor` | emergency | — | high | ✅ | — | ✅ | — | — | — | — |
| 19 | ABDM Longitudinal Risk Score | `abdm_longitudinal_risk` | emr | — | medium | ✅ | — | ✅ | — | — | — | — |
| 20 | Discharge Package Compose | `discharge_summary_compose` | emr | — | high | ✅ | ✅ | ✅ | — | — | — | — |
| 21 | Discharge Readiness | `discharge_readiness` | emr | — | high | ✅ | ✅ | ✅ | — | — | — | — |
| 22 | Multimodal Patient Timeline | `multimodal_patient_timeline` | emr | — | medium | ✅ | — | ✅ | — | — | — | — |
| 23 | Patient Record Summary | `patient_record_summary` | emr | — | high | ✅ | ✅ | ✅ | — | — | — | — |
| 24 | Dataset Labeling and Review Studio | `dataset_labeling_studio` | eval | — | low | ✅ | — | ✅ | — | — | — | — |
| 25 | Synthetic Clinical Case Generator | `synthetic_case_generator` | eval | — | low | ✅ | — | ✅ | — | — | — | — |
| 26 | Admin Policy Copilot | `admin_policy_copilot` | governance | — | medium | ✅ | — | — | — | — | — | — |
| 27 | AI Agent Lifecycle Manager | `ai_agent_lifecycle_manager` | governance | — | medium | ✅ | — | ✅ | — | — | — | — |
| 28 | AI Explainability Dashboard | `ai_explainability_dashboard` | governance | — | medium | ✅ | — | ✅ | — | — | — | — |
| 29 | Clinical Knowledge Graph | `clinical_knowledge_graph` | governance | — | low | ✅ | — | ✅ | — | — | — | — |
| 30 | Clinical Text De-identifier | `clinical_text_deidentifier` | governance | — | critical | ✅ | — | ✅ | — | — | — | — |
| 31 | Consent & PHI Policy Sentinel | `consent_phi_policy_sentinel` | governance | — | critical | ✅ | — | — | — | — | — | — |
| 32 | Federated Learning / Privacy-Preserving Training Layer | `federated_learning_coordinator` | governance | — | high | ✅ | — | ✅ | — | — | — | — |
| 33 | Model Registry and Evaluation Workbench | `model_registry_workbench` | governance | — | medium | ✅ | — | ✅ | — | — | — | — |
| 34 | Policy Diff / Regulation Watcher | `policy_regulation_watcher` | governance | — | medium | ✅ | — | ✅ | — | — | — | — |
| 35 | ICU Ventilator / Sedation Bundle Reviewer | `icu_ventilator_sedation_bundle` | icu | — | critical | ✅ | — | ✅ | ✅ | — | — | — |
| 36 | Infection Control Sentinel | `infection_control_sentinel` | infection_control | — | high | ✅ | — | — | ✅ | — | — | — |
| 37 | Lab Autoverification / Delta Check Assistant | `lab_autoverification_delta` | lab | — | high | ✅ | — | ✅ | — | — | — | — |
| 38 | Chart Completion Auditor | `chart_completion_auditor` | medical_records | — | high | ✅ | — | — | — | — | — | — |
| 39 | Document Intelligence / OCR | `document_intelligence_ocr` | medical_records | — | high | ✅ | — | ✅ | — | — | — | — |
| 40 | Pregnancy / Obstetric Risk Assistant | `obstetric_risk_assistant` | obstetrics | — | critical | ✅ | — | ✅ | ✅ | ✅ | — | — |
| 41 | OP Differential and Red Flag Aid | `op_differential_red_flags` | opd | — | critical | ✅ | — | ✅ | — | ✅ | — | — |
| 42 | OP Follow-Up Plan Draft | `op_follow_up_plan` | opd | — | medium | ✅ | — | ✅ | — | — | — | ✅ |
| 43 | OP Investigation Review Aid | `op_investigation_review` | opd | — | high | ✅ | — | ✅ | — | — | — | ✅ |
| 44 | OP Referral / Second Opinion Draft | `op_referral_draft` | opd | — | medium | ✅ | — | ✅ | — | — | — | — |
| 45 | OP Visit Prep | `op_visit_prep` | opd | — | high | ✅ | — | ✅ | — | — | — | — |
| 46 | Acuity-Based Staffing Forecast | `acuity_staffing_forecast` | operations | — | medium | ✅ | — | ✅ | ✅ | — | — | — |
| 47 | Appointment No-Show Predictor | `appointment_no_show_predictor` | operations | — | low | ✅ | — | — | — | — | — | — |
| 48 | Bed Discharge Forecast | `bed_discharge_forecast` | operations | — | medium | ✅ | ✅ | ✅ | — | — | — | — |
| 49 | Hospital Command Center AI | `hospital_command_center` | operations | — | medium | ✅ | — | ✅ | — | — | — | — |
| 50 | Housekeeping and Bed Turnover Optimizer | `housekeeping_bed_turnover` | operations | — | low | ✅ | — | ✅ | — | — | — | — |
| 51 | Inventory Intelligence (Non-Pharmacy) | `inventory_intelligence` | operations | — | medium | ✅ | — | ✅ | — | — | — | — |
| 52 | OT Block Scheduling Optimizer | `ot_block_scheduling` | operations | — | medium | ✅ | — | ✅ | — | — | — | — |
| 53 | OT Case-Time Predictor | `ot_case_time_predictor` | operations | — | low | ✅ | — | — | — | — | — | — |
| 54 | Procurement Negotiation Assistant | `procurement_negotiation_assistant` | operations | — | low | ✅ | — | ✅ | — | — | — | — |
| 55 | Self-Healing Bug Hunt Agent | `self_healing_bug_hunt` | operations | — | medium | ✅ | — | — | — | — | — | — |
| 56 | Staff Burnout / Workload Risk Predictor | `staff_burnout_workload_risk` | operations | — | medium | ✅ | — | ✅ | — | — | — | — |
| 57 | Staff Roster Optimizer | `staff_roster_optimizer` | operations | — | low | ✅ | — | — | — | — | — | — |
| 58 | Consent-Aware Family Update Generator | `consent_aware_family_update` | patient | — | high | ✅ | — | ✅ | — | — | ✅ | — |
| 59 | Generic Patient Report Explainer | `patient_report_explainer` | patient | — | medium | ✅ | — | ✅ | — | — | ✅ | — |
| 60 | Invoice Patient Explainer | `invoice_patient_explainer` | patient | — | low | ✅ | — | ✅ | — | — | ✅ | — |
| 61 | Lab Result Patient Explanation | `lab_patient_explanation` | patient | — | medium | ✅ | — | ✅ | — | — | ✅ | — |
| 62 | Patient Aftercare Instructions | `patient_aftercare_instructions` | patient | — | high | ✅ | ✅ | ✅ | — | — | ✅ | — |
| 63 | Patient Communication Translation | `patient_communication_translation` | patient | — | high | ✅ | — | ✅ | — | — | ✅ | — |
| 64 | Patient Record Chatbot | `patient_record_chatbot` | patient | — | high | ✅ | — | — | — | — | ✅ | — |
| 65 | Patient Teach-Back / Comprehension AI | `patient_teach_back_comprehension` | patient | — | high | ✅ | — | ✅ | — | — | ✅ | — |
| 66 | Post-Op Instruction Draft | `post_op_instruction_draft` | patient | — | high | ✅ | — | ✅ | — | — | ✅ | — |
| 67 | Prescription Patient Explainer | `prescription_patient_explainer` | patient | — | high | ✅ | — | ✅ | — | — | ✅ | — |
| 68 | Radiology Patient Explanation | `radiology_patient_explanation` | patient | — | high | ✅ | — | ✅ | — | — | ✅ | — |
| 69 | Voice Patient Assistant / IVR | `voice_patient_assistant_ivr` | patient_communication | — | high | ✅ | — | ✅ | — | — | ✅ | — |
| 70 | Antimicrobial Stewardship Assistant | `antimicrobial_stewardship` | pharmacy | — | critical | ✅ | — | ✅ | ✅ | — | — | ✅ |
| 71 | Medication Reconciliation | `medication_reconciliation` | pharmacy | — | critical | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| 72 | Pediatric Dosing Safety AI | `pediatric_dosing_safety` | pharmacy | — | critical | ✅ | — | ✅ | — | — | — | — |
| 73 | Pharmacogenomics / PGx Support | `pharmacogenomics_support` | pharmacy | — | high | ✅ | — | ✅ | — | — | — | — |
| 74 | Pharmacy Stockout Predictor | `pharmacy_stockout_predictor` | pharmacy | — | medium | ✅ | ✅ | ✅ | — | — | — | — |
| 75 | Polypharmacy AI Review | `polypharmacy_ai_review` | pharmacy | — | critical | ✅ | — | ✅ | ✅ | — | — | — |
| 76 | Mortality / RCA Draft Generator | `rca_draft_generator` | quality | — | medium | ✅ | — | — | — | — | — | — |
| 77 | Quality Case Review | `quality_case_review` | quality | — | high | ✅ | ✅ | ✅ | — | — | — | — |
| 78 | Radiology AI Interpretation | `radiology_ai_interpretation` | radiology | — | critical | ✅ | — | — | — | — | — | — |
| 79 | Radiology Report QA / Discrepancy Assistant | `radiology_report_qa` | radiology | — | high | ✅ | — | ✅ | — | — | — | — |
| 80 | Radiology Worklist Prioritizer | `radiology_worklist_prioritizer` | radiology | — | medium | ✅ | — | ✅ | — | — | — | — |
| 81 | Referral Letter | `referral_letter` | referral | — | medium | ✅ | ✅ | ✅ | — | — | — | — |
| 82 | Clinical Trial Matcher | `clinical_trial_matcher` | research | — | medium | ✅ | — | — | — | — | — | — |
| 83 | Appeal Letter Generator for Denied Claims | `appeal_letter_generator` | revenue_cycle | — | medium | ✅ | ✅ | ✅ | — | — | — | — |
| 84 | Charge Capture Audit | `charge_capture_audit` | revenue_cycle | — | medium | ✅ | — | — | ✅ | — | — | — |
| 85 | Clinical Coding Assistant | `clinical_coding_assist` | revenue_cycle | — | medium | ✅ | ✅ | ✅ | — | — | — | — |
| 86 | Payer Contract Variance / Underpayment AI | `payer_contract_variance` | revenue_cycle | — | medium | ✅ | — | ✅ | — | — | — | — |
| 87 | Prior Authorization Generator | `prior_authorization_generator` | revenue_cycle | — | medium | ✅ | — | — | — | — | — | — |
| 88 | Cybersecurity / Medical Device Anomaly Detector | `cybersecurity_anomaly_detector` | security | — | high | ✅ | — | ✅ | — | — | — | — |
| 89 | Teleconsult Note Draft | `teleconsult_note_draft` | telemedicine | — | high | ✅ | — | ✅ | — | ✅ | — | — |
| 90 | Teleconsult Pre-Visit Summary | `teleconsult_pre_visit_summary` | telemedicine | — | medium | ✅ | — | ✅ | — | — | — | — |
| 91 | Anesthesia Pre-Check Assistant | `anesthesia_precheck_assistant` | theatre | — | critical | ✅ | — | ✅ | — | ✅ | — | — |
| 92 | Implant + Consumable Tracker | `implant_consumable_tracker` | theatre | — | high | ✅ | — | ✅ | — | — | — | — |
| 93 | Operative Note Draft | `ot_note_draft` | theatre | — | high | ✅ | — | ✅ | — | ✅ | — | — |
| 94 | Post-Op Complication Alert | `post_op_complication_alert` | theatre | — | critical | ✅ | — | ✅ | — | ✅ | — | — |
| 95 | Pre-Op Checklist Review | `preop_checklist_review` | theatre | — | critical | ✅ | — | ✅ | — | ✅ | — | — |
| 96 | Surgical Consent Draft | `surgical_consent_draft` | theatre | — | high | ✅ | — | ✅ | — | ✅ | — | — |
| 97 | Surgical Risk Summary | `surgical_risk_summary` | theatre | — | critical | ✅ | — | ✅ | — | ✅ | — | — |
| 98 | Virtual Ward Triage | `virtual_ward_triage` | virtual_ward | — | high | ✅ | — | — | — | — | ✅ | — |
| 99 | Daily Ward Round Brief | `daily_ward_round_brief` | ward | — | high | ✅ | — | ✅ | — | — | — | — |

## How "enabled" works (3 layers)

1. **Code `enabled` flag** = seed default only (the table above).
2. **`clinical_ai_modules` table** = the seeded catalog; once a row exists the DB value wins and code-default flips are inert.
3. **`clinical_ai_tenant_modules` table** = the per-tenant on/off switch (`updateClinicalAiTenantModule`). **This is what you write to enable a module for a hospital.** Empty at bootstrap → every tenant inherits the seed defaults until overridden.

For an external LLM provider, a module also needs its per-module `external_allowed` flag set **in addition** to the env-level `CLINICAL_AI_ALLOW_EXTERNAL`.

## Activation checklist (per module, before flipping ON)

- [ ] Provider reachable — `CLINICAL_AI_PROVIDER`/`BASE_URL`/`MODEL` (+ `DEEP_*` for deep-tier modules) configured and a smoke-gen returns `ai_metadata.used_ai: true`.
- [ ] Reviewers staffed — at least one active user holds each role in the module's sign-off `reviewRoles[]`.
- [ ] (KB modules) embedder configured + curation-**approved** chunks exist, else grounding silently no-ops.
- [ ] (high/critical or `two_person_for_enablement`) a second approver + an accepted `clinical_ai_model_eval_runs` row.
- [ ] Per-tenant toggle written to `clinical_ai_tenant_modules` (not the global catalog).
- [ ] Patient-facing modules stay OFF pending an explicit go-patient-facing decision.

---
_Provenance: registry attributes are read directly from the registry array; Svc/Route/Test columns are a `git grep` of the module_key over `apps/backend/src` at generation time. Live per-tenant enablement (which modules a running hospital actually has ON) lives in `clinical_ai_tenant_modules` and must be queried from that deployment's database — it is not represented here._
