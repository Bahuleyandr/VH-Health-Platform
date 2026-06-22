import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const CLINICAL_AI_MODULES = [
  {
    module_key: 'discharge_summary_compose',
    display_name: 'Discharge Package Compose',
    description: 'Meta-workflow that orchestrates medication reconciliation, aftercare instructions, discharge readiness, and clinical coding subgraphs into a unified discharge package. Each component remains independently reviewable; the parent run links them via clinical_ai_workflow_runs.parent_run_id and rolls up their safety flags.',
    enabled: false,
    settings: {
      surface: 'emr',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: false, // citations live on each child draft
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: {
        type: 'object',
        required: ['admission_id', 'components', 'overall_safety_band'],
      },
      retentionDays: 365,
      // Subgraph-orchestration only — no LLM call at the parent level.
      // The model_tier knob is meaningless here; children inherit their
      // own tiers from their respective module configs.
      isComposeWorkflow: true,
      // Toggle individual children. By default all four are spawned;
      // a tenant-specific config can disable e.g. clinical_coding_assist
      // if their billing workflow doesn't use it.
      composeChildren: [
        'medication_reconciliation',
        'patient_aftercare_instructions',
        'discharge_readiness',
        'clinical_coding_assist',
      ],
      // When true, a node returns pauseRun('await_governance') after
      // assemble + persist, parking the run until an external scheduler
      // detects governance approval and resumes it.
      requireGovernanceApproval: false,
    },
  },
  {
    module_key: 'discharge_summary',
    display_name: 'Discharge Summary Drafts',
    description: 'Drafts clinician-reviewed discharge summaries from inpatient chart context.',
    enabled: true,
    settings: {
      surface: 'emr',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: { type: 'object', required: ['hospital_course', 'discharge_diagnosis'] },
      retentionDays: 365,
      // Discharge summaries assemble multi-source narrative (course of stay,
      // diagnoses, medications, follow-up). Routing through the deep tier
      // when CLINICAL_AI_DEEP_* is configured, falling back to the standard
      // tier otherwise.
      model_tier: 'deep',
    },
  },
  {
    module_key: 'handover_summary',
    display_name: 'Nursing Handover Drafts',
    description: 'Drafts shift handover notes from recent patient timeline events.',
    enabled: true,
    settings: {
      surface: 'clinical',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF'],
      approvalPolicy: 'clinician_review',
      outputSchema: { type: 'object', required: ['patient_summary', 'active_issues'] },
      retentionDays: 180,
    },
  },
  {
    module_key: 'patient_record_summary',
    display_name: 'Patient Record Summary',
    description: 'Longitudinal inpatient chart summary across notes, diagnoses, meds, vitals, labs, imaging, allergies, procedures, and tasks.',
    enabled: false,
    settings: {
      surface: 'emr',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: { type: 'object', required: ['summary', 'active_problems', 'pending_tasks'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'op_visit_prep',
    display_name: 'OP Visit Prep',
    description: 'Doctor-facing OPD pre-consult brief from the appointment reason, allergies, prior diagnoses, recent notes, medications, and investigations. Decision-support only; never patient-facing and never autonomous.',
    enabled: false,
    settings: {
      surface: 'opd',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: { type: 'object', required: ['brief', 'active_problems', 'things_to_review'] },
      retentionDays: 180,
      decisionSupportOnly: true,
      patientFacing: false,
    },
  },
  {
    module_key: 'op_investigation_review',
    display_name: 'OP Investigation Review Aid',
    description: 'Doctor-facing OPD lab/radiology review aid that summarizes abnormalities, recent trends, and urgency cues from supplied results. Decision-support only; never patient-facing.',
    enabled: false,
    settings: {
      surface: 'opd',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: { type: 'object', required: ['summary', 'abnormalities', 'suggested_clinical_correlation'] },
      retentionDays: 180,
      decisionSupportOnly: true,
      patientFacing: false,
      // WS5 B5.5 — curated-KB grounding (additive). When approved
      // documents of these kb_types exist for the tenant, their chunks
      // are merged into the prompt context + citations alongside the
      // chart packet. Graceful: empty/unavailable KB leaves generation
      // unchanged. See knowledgeGroundingService.js.
      knowledgeBases: ['clinical_guideline', 'sop'],
    },
  },
  {
    module_key: 'op_differential_red_flags',
    display_name: 'OP Differential and Red Flag Aid',
    description: 'Doctor-facing OPD checklist that suggests differentials to consider, red flags not to miss, and possible next questions or examinations. It does not diagnose or order.',
    enabled: false,
    settings: {
      surface: 'opd',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: { type: 'object', required: ['do_not_miss_red_flags', 'differentials_to_consider', 'suggested_next_checks'] },
      retentionDays: 180,
      model_tier: 'deep',
      decisionSupportOnly: true,
      patientFacing: false,
    },
  },
  {
    module_key: 'op_follow_up_plan',
    display_name: 'OP Follow-Up Plan Draft',
    description: 'Doctor-facing OPD follow-up planning aid that drafts monitoring parameters, review timing, repeat tests, and warning signs for clinician editing.',
    enabled: false,
    settings: {
      surface: 'opd',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: { type: 'object', required: ['follow_up_timing', 'monitoring_plan', 'repeat_tests'] },
      retentionDays: 180,
      decisionSupportOnly: true,
      patientFacing: false,
      // WS5 B5.5 — curated-KB grounding (additive, graceful). Follow-up
      // monitoring intervals + repeat-test cadence benefit from hospital
      // protocol / guideline material. See knowledgeGroundingService.js.
      knowledgeBases: ['clinical_guideline', 'sop'],
    },
  },
  {
    module_key: 'op_referral_draft',
    display_name: 'OP Referral / Second Opinion Draft',
    description: 'Doctor-facing OPD referral or second-opinion draft from the encounter context, provisional diagnosis, investigations, and current treatment. Clinician edits and signs.',
    enabled: false,
    settings: {
      surface: 'opd',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: { type: 'object', required: ['reason_for_referral', 'clinical_summary', 'questions_for_specialist'] },
      retentionDays: 365,
      decisionSupportOnly: true,
      patientFacing: false,
    },
  },
  {
    module_key: 'clinical_task_extractor',
    display_name: 'Clinical Task Extractor',
    description: 'Extracts reviewable pending tasks from notes, handovers, discharge plans, ward rounds, orders, investigations, and ambient or voice-derived notes without silent assignment.',
    enabled: false,
    settings: {
      surface: 'clinical_operations',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS', 'ADMIN'],
      approvalPolicy: 'task_review_queue',
      outputSchema: { type: 'object', required: ['tasks'] },
      retentionDays: 365,
      noAutoAssign: true,
    },
  },
  {
    module_key: 'daily_ward_round_brief',
    display_name: 'Daily Ward Round Brief',
    description: 'Per-admitted-patient overnight events, abnormal results, medication changes, pending investigations, nursing concerns, and discharge blockers.',
    enabled: false,
    settings: {
      surface: 'ward',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: { type: 'object', required: ['ward', 'patients'] },
      retentionDays: 90,
    },
  },
  {
    module_key: 'patient_aftercare_instructions',
    display_name: 'Patient Aftercare Instructions',
    description: 'Patient-friendly discharge instructions from signed discharge summary, meds, follow-up, warning signs, diet, and activity guidance.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: { type: 'object', required: ['plain_language_summary', 'medications', 'warning_signs'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'medication_reconciliation',
    display_name: 'Medication Reconciliation',
    description: 'Compares home meds, inpatient MAR/orders, allergies, duplicates, and discharge meds into continue/stop/change suggestions.',
    enabled: false,
    settings: {
      surface: 'pharmacy',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'PHARMACY_STAFF', 'NURSING_STAFF'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: { type: 'object', required: ['continue', 'stop', 'change', 'safety_flags'] },
      retentionDays: 365,
      // Critical-risk drug reconciliation; deep tier gives a stronger
      // model when CLINICAL_AI_DEEP_* is set.
      model_tier: 'deep',
      // WS5 B5.5 — curated-KB grounding (additive, graceful). Formulary +
      // guideline chunks help reconcile home/inpatient/discharge meds
      // against hospital-approved agents. The chart packet remains the
      // authoritative citation source. See knowledgeGroundingService.js.
      knowledgeBases: ['formulary', 'clinical_guideline'],
    },
  },
  {
    module_key: 'antimicrobial_stewardship',
    display_name: 'Antimicrobial Stewardship Assistant',
    description: 'Reviews antibiotics against cultures, fever trend, renal function, allergies, duration, de-escalation, IV-to-oral switch, and duplicate spectrum from cited inpatient evidence.',
    enabled: false,
    settings: {
      surface: 'pharmacy',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'PHARMACY_STAFF', 'INFECTION_CONTROL', 'NURSING_STAFF'],
      approvalPolicy: 'stewardship_review',
      outputSchema: { type: 'object', required: ['stewardship_score', 'risk_band', 'flags', 'recommendations'] },
      retentionDays: 3650,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      // WS5 B5.5 — curated-KB grounding (additive, graceful). Local
      // antibiotic policy / antibiogram + formulary chunks ground
      // de-escalation, IV-to-oral, and duration advisories in the
      // hospital's own stewardship reference material. Rules stay
      // authoritative; KB is decision-support context only.
      knowledgeBases: ['antibiotic_policy', 'clinical_guideline', 'formulary'],
    },
  },
  {
    module_key: 'blood_bank_demand_forecast',
    display_name: 'Blood Bank Demand and Compatibility Forecast',
    description: 'Projects blood-component demand from upcoming OT / trauma / emergency workload, reconciles against current inventory per blood group, flags stockout risk, and assesses MTP readiness. Review-only; never commits/reserves units automatically.',
    enabled: false,
    settings: {
      surface: 'blood_bank',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BLOOD_BANK_STAFF', 'LAB_STAFF', 'DOCTOR', 'ADMIN'],
      approvalPolicy: 'blood_bank_review',
      outputSchema: { type: 'object', required: ['predicted_demand', 'risk_band', 'stockout_risks'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'obstetric_risk_assistant',
    display_name: 'Pregnancy / Obstetric Risk Assistant',
    description: 'Classifies antenatal / intrapartum / postpartum risk factors and red-flag signals (preeclampsia, eclampsia, PPH, reduced fetal movement, fetal bradycardia) from vitals, labs, gravida/parity, and prior conditions. Emits a risk score, band, ANC follow-up plan, and escalation criteria. Review-only.',
    enabled: false,
    settings: {
      surface: 'obstetrics',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'OBSTETRICIAN', 'ADMIN'],
      approvalPolicy: 'obstetric_review',
      outputSchema: { type: 'object', required: ['risk_score', 'risk_band', 'risk_factors', 'red_flag_signals'] },
      retentionDays: 3650,
      rulesAuthoritative: true,
      // Critical-risk module covering rare red-flag signals; benefits from
      // the stronger deep-tier model. Differential debate also enabled.
      model_tier: 'deep',
      enableDifferentialDebate: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'icu_ventilator_sedation_bundle',
    display_name: 'ICU Ventilator / Sedation Bundle Reviewer',
    description: 'Audits VAP bundle, daily sedation interruption, CAM-ICU delirium screening, and SBT readiness from cited ICU chart evidence. Computes a bundle compliance score and risk band; never changes orders.',
    enabled: false,
    settings: {
      surface: 'icu',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'ICU_TEAM', 'PULMONOLOGIST', 'ADMIN'],
      approvalPolicy: 'icu_bundle_review',
      outputSchema: { type: 'object', required: ['compliance_score', 'risk_band', 'vap_bundle', 'bundle_gaps'] },
      retentionDays: 3650,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'housekeeping_bed_turnover',
    display_name: 'Housekeeping and Bed Turnover Optimizer',
    description: 'Predicts bed cleaning level and turnover time per discharge + priority score based on bed demand, isolation precautions, and ED proximity. Review-only; never auto-assigns housekeeping tasks.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'HOUSEKEEPING_STAFF', 'BED_MANAGER', 'DEPARTMENT_HEAD'],
      approvalPolicy: 'ops_review',
      outputSchema: { type: 'object', required: ['priority_band', 'predicted_turnover_minutes', 'required_cleaning_level'] },
      retentionDays: 365,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'biomed_device_maintenance',
    display_name: 'Biomedical Device Maintenance Predictor',
    description: 'Predicts failure risk for biomedical devices (ventilators, defibrillators, infusion pumps, monitors, imaging equipment) from usage hours, fault events, MTBF, and service history. Emits risk score, urgency window, and recommended actions. Review-only.',
    enabled: false,
    settings: {
      surface: 'biomedical',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'BIOMEDICAL_STAFF', 'FACILITY_MANAGER'],
      approvalPolicy: 'biomed_review',
      outputSchema: { type: 'object', required: ['predicted_failure_risk_score', 'risk_band'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'cybersecurity_anomaly_detector',
    display_name: 'Cybersecurity / Medical Device Anomaly Detector',
    description: 'Flags security anomalies across user logins (impossible travel, brute force, credential stuffing), admin actions, data exports, medical device traffic, and API usage. Review-only; security officer decides on response actions.',
    enabled: false,
    settings: {
      surface: 'security',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'IT_ADMIN', 'SECURITY_OFFICER'],
      approvalPolicy: 'security_review',
      outputSchema: { type: 'object', required: ['anomaly_category', 'severity', 'risk_score'] },
      retentionDays: 2555,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'pharmacogenomics_support',
    display_name: 'Pharmacogenomics / PGx Support',
    description: 'Matches prescribed medications against patient genotypes (CYP2D6, CYP2C19, CYP2C9, VKORC1, SLCO1B1, HLA-B*57:01, HLA-B*15:02, TPMT, DPYD, UGT1A1, G6PD) using a CPIC-inspired reference table. Emits dose-adjust / alternative / contraindicated advisories. Review-only; pharmacist signoff required.',
    enabled: false,
    settings: {
      surface: 'pharmacy',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'PHARMACIST', 'PHARMACY_STAFF', 'ADMIN'],
      approvalPolicy: 'pharmacist_review',
      outputSchema: { type: 'object', required: ['advisory_category', 'severity', 'matched_genes'] },
      retentionDays: 3650,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'acuity_staffing_forecast',
    display_name: 'Acuity-Based Staffing Forecast',
    description: 'Acuity-weighted staffing forecast per unit. Takes patient census by acuity level (critical/high/moderate/low), current staff by role, predicted admissions/discharges, and shift window, applies role-based ratios (1:2 critical, 1:4 high, 1:5 moderate, 1:6 low for nurses; assistants at half that density), computes required vs current staff and a deficit/surplus per role, forecasts peak demand for the shift, and classifies a recommendation (`hold_staffing` / `call_in` / `float_staff` / `reduce_staff` / `emergency_acuity`). Rules are authoritative; review-only — house supervisor approves and calls staff, and the module never dispatches staff automatically.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'HOUSE_SUPERVISOR', 'NURSE_MANAGER'],
      approvalPolicy: 'house_supervisor_review',
      outputSchema: { type: 'object', required: ['recommendation', 'severity'] },
      retentionDays: 730,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'federated_learning_coordinator',
    display_name: 'Federated Learning / Privacy-Preserving Training Layer',
    description: 'Governance + coordination layer for federated / privacy-preserving clinical ML training. Registers participating sites (contact, status, last_seen, differential-privacy epsilon budget, min cohort size, accepted aggregation methods) and tracks rounds (participant count, aggregation method, DP ε spent, cohort sizes, data-drift score). Classifies round readiness as `ready` / `hold` / `abort` / `review_privacy` / `no_action` based on participant count vs min, DP budget headroom, min site cohort vs floor, and drift score. Rules are authoritative; review-only — AI governance + data engineering approve rounds; the module never triggers training or transmits weights. Coordination + audit only.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'AI_EVAL_LEAD', 'AI_GOVERNANCE', 'DATA_ENGINEER'],
      approvalPolicy: 'ai_governance_review',
      outputSchema: { type: 'object', required: ['recommendation', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      noTrainingExecution: true,
    },
  },
  {
    module_key: 'voice_patient_assistant_ivr',
    display_name: 'Voice Patient Assistant / IVR',
    description: 'Consent-gated voice/IVR session classifier for patient-facing prep, aftercare, meds, reminders, virtual-ward check-ins, and triage callbacks. Given a transcript + intent + consent reference + candidate response, detects urgent/emergency phrases (escalate), PHI leakage risk in the candidate response (block + sanitize), missing or stale consent (block), unsupported language or intent (fallback to human). Emits a per-session recommendation — `allow` / `escalate_to_clinician` / `block` / `fallback_to_human` / `no_action`. Rules are authoritative; review-only — a downstream dispatcher delivers only after reviewer approval (or via admin-approved template path). The module itself never plays audio or sends a reply.',
    enabled: false,
    settings: {
      surface: 'patient_communication',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSE', 'ADMIN'],
      approvalPolicy: 'clinician_review',
      outputSchema: { type: 'object', required: ['recommendation', 'severity'] },
      retentionDays: 1095,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      consentRequired: true,
    },
  },
  {
    module_key: 'policy_regulation_watcher',
    display_name: 'Policy Diff / Regulation Watcher',
    description: 'Takes two versions of a policy, regulation, or payer rule (or a direct diff) and computes added / removed / modified sections. Classifies overall impact area (clinical / billing / access / privacy / infection_control / pharmacy / none / mixed) and severity (critical / high / moderate / low). Identifies impacted roles (doctors, nurses, billing, pharmacy, etc.) so the right teams are notified. Rules are authoritative; review-only — compliance and legal approve before downstream rollout, and the module never auto-activates or revokes a policy.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'COMPLIANCE_LEAD', 'LEGAL'],
      approvalPolicy: 'compliance_review',
      outputSchema: { type: 'object', required: ['impact_area', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'multimodal_patient_timeline',
    display_name: 'Multimodal Patient Timeline',
    description: 'Unifies events from chart notes, imaging, voice/ambient, claims, patient messages, device telemetry, documents, prescriptions, labs, and vitals into a single patient timeline snapshot. Classifies each event by kind + clinical relevance band (critical / high / moderate / low / informational), detects patient-safety signals (red-flag vitals, critical labs, abnormal imaging, missed meds, PHI leakage in messages), and orders by (time, relevance). Rules are authoritative; review-only — the care team reviews the rolled-up timeline, and the module never modifies the source events or the chart.',
    enabled: false,
    settings: {
      surface: 'emr',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSE', 'ADMIN'],
      approvalPolicy: 'clinician_review',
      outputSchema: { type: 'object', required: ['overall_severity', 'timeline_events'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'pathway_bundle_compliance',
    display_name: 'Generalized Pathway Bundle Compliance',
    description: 'Generic clinical pathway bundle evaluator. Accepts a pathway spec (list of required items with timing constraints) + actual actions + t0 reference time, classifies each item as compliant / late / missed / not_applicable / unknown, computes bundle-wide compliance %, surfaces dangerously-late or missed critical items, and recommends an action (no_action / catch_up / escalate / review_pathway / critical_miss). Covers stroke Get-With-The-Guidelines, ACS MONA, VTE prophylaxis, insulin/glycemic control, pain management, and similar. Distinct from sepsis_bundle_sentinel which is sepsis-specific. Rules are authoritative; review-only — clinician reviews; the module never administers medication or places orders.',
    enabled: false,
    settings: {
      surface: 'clinical',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSE', 'ADMIN'],
      approvalPolicy: 'clinician_review',
      outputSchema: { type: 'object', required: ['compliance_pct', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      // WS5 B5.5 — curated-KB grounding (additive, graceful). Pathway /
      // bundle guideline + SOP chunks ground the narrative summary in the
      // hospital's own protocol documents. Rule-based compliance scoring
      // stays authoritative; KB never overrides item classifications.
      knowledgeBases: ['clinical_guideline', 'sop'],
    },
  },
  {
    module_key: 'clinical_knowledge_graph',
    display_name: 'Clinical Knowledge Graph',
    description: 'Lightweight clinical knowledge graph over 9 node types (patient, diagnosis, medication, lab, procedure, provider, encounter, payer, organization) and 14 edge types (has_diagnosis, prescribed, ordered, performed_by, administered_to, attributed_to, covered_by, affiliated_with, belongs_to_encounter, treats, contraindicates, indicates, related_to, caused_by). Stores nodes + edges + periodic health reports. Health reports classify orphan nodes, missing critical edges, contradictions, stale nodes, and compute completeness %. Rules are authoritative; review-only — data engineer approves health-report fixes; the graph itself is never modified by this service (ingest happens upstream).',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'AI_EVAL_LEAD', 'DATA_ENGINEER'],
      approvalPolicy: 'data_engineer_review',
      outputSchema: { type: 'object', required: ['overall_health', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'ai_explainability_dashboard',
    display_name: 'AI Explainability Dashboard',
    description: 'Per-draft explainability analysis for any clinical AI generation. Computes citation coverage %, unsupported-claim count, numeric coherence %, PHI leakage indicators, bias markers (gender/age/race language unsupported by the chart context), and a reviewer-friendly evidence map. Rule-based trust band (trusted / review / reject). Review-only — AI governance uses it to green-light a draft for clinical use; the module never modifies the underlying draft.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'AI_EVAL_LEAD', 'AI_GOVERNANCE'],
      approvalPolicy: 'ai_governance_review',
      outputSchema: { type: 'object', required: ['trust_band', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'ai_agent_lifecycle_manager',
    display_name: 'AI Agent Lifecycle Manager',
    description: 'Registry of AI agents (distinct from models): agent_key, owner, purpose, scopes, permitted actions, expiry, last_seen, and lifecycle stage (sandbox/staging/production/deprecated/quarantined). Periodic health reports classify each agent as renew / hold / retire / quarantine / no_action based on invocation count, success rate, error rate, avg latency, permission-vs-usage mismatch, days_since_last_seen, and days_to_expiry. Rules are authoritative; review-only — AI governance approves renewals and retirements, and the module never disables or extends an agent automatically.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'AI_EVAL_LEAD', 'AI_GOVERNANCE'],
      approvalPolicy: 'ai_governance_review',
      outputSchema: { type: 'object', required: ['recommendation', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'hospital_command_center',
    display_name: 'Hospital Command Center AI',
    description: 'Cross-department operational command center. Takes a snapshot of bed occupancy, ED wait/boarding/LWBS, OR utilization/overruns/add-on pressure, housekeeping turnover backlog, radiology pending/stat wait, and pharmacy dispense backlog/critical meds late, classifies each department to a tier (normal / watch / elevated / crisis), and rolls up to a hospital-wide command_status. Rules are authoritative; review-only — the duty officer reviews, and the module never auto-triggers diversion, staffing changes, or transfers.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'HOUSE_SUPERVISOR', 'DOCTOR'],
      approvalPolicy: 'duty_officer_review',
      outputSchema: { type: 'object', required: ['command_status', 'department_status'] },
      retentionDays: 730,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'dataset_labeling_studio',
    display_name: 'Dataset Labeling and Review Studio',
    description: 'Generic labeling studio for AI eval/training datasets across task types (imaging, clinical coding, denial reasons, deterioration outcomes, triage outcomes, discharge disposition, etc.). Tracks labeling tasks (one row per input item) and annotations (one row per labeler). Computes inter-rater agreement (match / partial / disagree / pending) and confidence band (high / medium / low). A task becomes ready_to_use only when ≥ 2 accepted annotations agree; conflicts go to adjudicator review. Rules are authoritative; review-only — eval lead approves, and the module never auto-publishes an item into a dataset.',
    enabled: false,
    settings: {
      surface: 'eval',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: false,
      reviewRoles: ['ADMIN', 'AI_EVAL_LEAD', 'DATA_LABELER', 'DOCTOR'],
      approvalPolicy: 'eval_lead_review',
      outputSchema: { type: 'object', required: ['dataset_key', 'status'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'synthetic_case_generator',
    display_name: 'Synthetic Clinical Case Generator',
    description: 'Deterministic de-identified synthetic-case generator for AI eval, canary suites, regression tests, demos, and edge-case exploration. Given a pathway, complexity tier, persona template, and PRNG seed, produces demographics, chief complaint, vitals, labs, a timeline of events, and edge-flag annotations. Review-only — cases require eval-lead approval before entering a canary set or training corpus, and the module never touches real patient data.',
    enabled: false,
    settings: {
      surface: 'eval',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: false,
      reviewRoles: ['ADMIN', 'AI_EVAL_LEAD', 'DOCTOR'],
      approvalPolicy: 'eval_lead_review',
      outputSchema: { type: 'object', required: ['case_label', 'pathway', 'persona'] },
      retentionDays: 730,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      neverRealPatientData: true,
    },
  },
  {
    module_key: 'training_simulation_coach',
    display_name: 'Training and Simulation Coach',
    description: 'Converts de-identified clinical incidents (mortality, near-miss, delayed diagnosis, medication error, handoff failure, infection outbreak, equipment failure) into structured training/simulation modules: learning objectives, decision points, debrief questions, reference guidelines, and suggested simulation format. Rules are authoritative; scrubs supplied summaries for residual PHI (phone/MRN/name/email/Aadhaar) and flags if any is detected. Review-only — the training director approves before publishing to staff, and the module never auto-publishes or assigns training.',
    enabled: false,
    settings: {
      surface: 'education',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'TRAINING_LEAD', 'DOCTOR'],
      approvalPolicy: 'training_director_review',
      outputSchema: { type: 'object', required: ['learning_objectives', 'decision_points'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      phiScrubRequired: true,
    },
  },
  {
    module_key: 'model_registry_workbench',
    display_name: 'Model Registry and Evaluation Workbench',
    description: 'Central registry of every AI model variant the platform uses (name, version, provider, lineage, purpose, owner, lifecycle stage) plus an eval-run log capturing accuracy, F1, average latency, fallback rate, safety-flag rate, and drift score per suite. Rules are authoritative for recommending a lifecycle action (promote / hold / rollback / retire / quarantine / no_action) based on deltas against the last accepted eval for the same model. Review-only — AI eval lead approves promotions and retirements; the module never automatically changes a model\'s stage.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'AI_EVAL_LEAD', 'AI_GOVERNANCE'],
      approvalPolicy: 'ai_eval_lead_review',
      outputSchema: { type: 'object', required: ['recommendation', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'procurement_negotiation_assistant',
    display_name: 'Procurement Negotiation Assistant',
    description: 'Hospital procurement decision-support for non-pharmacy and pharmacy line items. Given SKU, vendor, current unit price, historical baseline, quoted alternatives, annual volume, vendor count for the category, and contract tenure/end date, classifies opportunities as price_anomaly / volume_consolidation / tenure_leverage / alternatives_available / expiring_contract / no_action and estimates annual savings potential. Rules are authoritative; review-only — the procurement lead negotiates, and the module never contacts vendors, places orders, or modifies contracts.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'PROCUREMENT_LEAD', 'MATERIALS_MANAGER'],
      approvalPolicy: 'procurement_lead_review',
      outputSchema: { type: 'object', required: ['opportunity_category', 'severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'radiology_report_qa',
    display_name: 'Radiology Report QA / Discrepancy Assistant',
    description: 'Reviews draft and signed radiology reports against the study request indication and metadata. Flags laterality mismatches, missing impression sections, missing critical-finding communication notes, unaddressed indications, missing comparison-to-prior, vague measurements, findings-vs-impression inconsistencies, and missing follow-up recommendations. Rules are authoritative; review-only — never modifies, signs, or releases a report, and always requires radiologist signoff.',
    enabled: false,
    settings: {
      surface: 'radiology',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'RADIOLOGIST', 'ADMIN'],
      approvalPolicy: 'radiologist_review',
      outputSchema: { type: 'object', required: ['discrepancies', 'overall_severity'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'radiology_worklist_prioritizer',
    display_name: 'Radiology Worklist Prioritizer',
    description: 'Scores pending radiology studies across modality, patient location (ED/ICU/ward/outpatient), suspected findings, fragility, wait time, and ordering context, and assigns a priority tier (stat / urgent / routine / deferrable). Review-only — never changes the worklist automatically; the radiologist lead reviews and accepts or overrides the suggested order.',
    enabled: false,
    settings: {
      surface: 'radiology',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'RADIOLOGIST', 'ADMIN'],
      approvalPolicy: 'radiologist_review',
      outputSchema: { type: 'object', required: ['priority_tier', 'priority_score'] },
      retentionDays: 365,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'ot_block_scheduling',
    display_name: 'OT Block Scheduling Optimizer',
    description: 'Reviews OR block utilization across surgeons and service lines. Evaluates prime-time utilization %, add-on case volume, turnover times, case-duration accuracy, overrun frequency, and block hours used vs allocated, and produces a reallocation suggestion (keep / expand / reduce / reallocate / review_release_policy). Rules are authoritative; review-only — the OR director approves, and the module never reassigns block time automatically.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'OT_MANAGER', 'DOCTOR'],
      approvalPolicy: 'ot_director_review',
      outputSchema: { type: 'object', required: ['recommendation', 'severity'] },
      retentionDays: 1095,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'inventory_intelligence',
    display_name: 'Inventory Intelligence (Non-Pharmacy)',
    description: 'Reviews non-pharmacy hospital inventory (PPE, linens, surgical instruments, consumables, biomed single-use items, housekeeping supplies). Classifies each item as stockout_risk / reorder_point_breach / overstock / expiry_risk / consumption_anomaly / healthy using current stock, reorder point, days-on-hand, expiry dates, and consumption deviation vs baseline. Rules are authoritative; review-only — the materials manager approves, and the module never places or cancels orders automatically.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'MATERIALS_MANAGER', 'PHARMACY_STAFF'],
      approvalPolicy: 'materials_manager_review',
      outputSchema: { type: 'object', required: ['alert_category', 'severity'] },
      retentionDays: 1095,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      nonPharmacyOnly: true,
    },
  },
  {
    module_key: 'ed_triage_boarding_predictor',
    display_name: 'ED Triage and Boarding Predictor',
    description: 'Computes an ESI-like triage level (1-5), predicts specialty + disposition, and forecasts ED boarding risk from chief complaint, vitals, pain, arrival mode, and current ED occupancy. Review-only; never auto-admits or redirects patients.',
    enabled: false,
    settings: {
      surface: 'emergency',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'ED_CHARGE_NURSE', 'ADMIN'],
      approvalPolicy: 'ed_triage_review',
      outputSchema: { type: 'object', required: ['triage_level', 'boarding_risk_band', 'predicted_disposition'] },
      retentionDays: 365,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'staff_burnout_workload_risk',
    display_name: 'Staff Burnout / Workload Risk Predictor',
    description: 'Computes per-staff workload metrics (total hours, overtime, consecutive night shifts, PTO utilization) from existing attendance + roster + leave data, then classifies burnout risk (low / moderate / high / critical) with contributing signals and recommended actions. Review-only, strictly decision-support. Privacy boundary: never used for performance or disciplinary action.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF', 'DEPARTMENT_HEAD'],
      approvalPolicy: 'hr_review',
      outputSchema: { type: 'object', required: ['risk_score', 'risk_band', 'contributing_signals'] },
      retentionDays: 730,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      privacyNote: 'Workload risk signal only — never used for performance evaluation or disciplinary action.',
    },
  },
  {
    module_key: 'pediatric_dosing_safety',
    display_name: 'Pediatric Dosing Safety AI',
    description: 'Checks a prescribed pediatric dose against patient weight, age band, and a per-drug max-dose reference table (paracetamol, ibuprofen, common antibiotics, ondansetron, vancomycin, gentamicin, salbutamol). Classifies safety as safe / caution / unsafe / missing_data and suggests actions. Review-only; never modifies orders.',
    enabled: false,
    settings: {
      surface: 'pharmacy',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'PHARMACIST', 'PHARMACY_STAFF', 'ADMIN'],
      approvalPolicy: 'pediatric_dose_review',
      outputSchema: { type: 'object', required: ['safety_band', 'calculated_max_dose_mg', 'medication_name'] },
      retentionDays: 2555,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'lab_autoverification_delta',
    display_name: 'Lab Autoverification / Delta Check Assistant',
    description: 'Flags lab results that significantly diverge from the patient\'s prior result for the same test and detects critical-value overflows. Produces an autoverification decision (auto_verify / hold_for_review / critical) that a lab reviewer signs off. Rules authoritative; never finalizes results automatically.',
    enabled: false,
    settings: {
      surface: 'lab',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['LAB_STAFF', 'DOCTOR', 'PATHOLOGIST', 'ADMIN'],
      approvalPolicy: 'lab_review',
      outputSchema: { type: 'object', required: ['decision', 'critical_band', 'test_name'] },
      retentionDays: 1825,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'payer_contract_variance',
    display_name: 'Payer Contract Variance / Underpayment AI',
    description: 'Ingests contracted rates per payer + procedure and flags insurance claims where expected vs. paid amounts diverge — underpayment, overpayment, missing contract, or missing payment. Review-only; never auto-appeals or writes off claims.',
    enabled: false,
    settings: {
      surface: 'revenue_cycle',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BILLING_STAFF', 'INSURANCE_COORDINATOR', 'ADMIN', 'SUPER_ADMIN'],
      approvalPolicy: 'revenue_cycle_review',
      outputSchema: { type: 'object', required: ['variance_category', 'variance_band', 'expected_amount_minor', 'paid_amount_minor'] },
      retentionDays: 2555,
      default_tolerance_pct: 2,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'consent_aware_family_update',
    display_name: 'Consent-Aware Family Update Generator',
    description: 'Drafts a plain-language, consent-scoped status update for a named caregiver or family member. Verifies an active patient consent before generating; enforces PHI-boundary scrubbing (no specific doses, no raw lab values); requires clinician review and never auto-sends.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_review_required',
      outputSchema: { type: 'object', required: ['plain_language_summary', 'current_status', 'next_steps', 'when_to_worry'] },
      retentionDays: 1095,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      supported_languages: ['en', 'hi', 'ta', 'te', 'ml', 'mr', 'bn', 'kn'],
    },
  },
  {
    module_key: 'nursing_ambient_documentation',
    display_name: 'Nursing Ambient Documentation',
    description: 'Bedside nursing shift documentation from an ambient multi-speaker transcript. Extracts structured observations — wounds, drains, IV lines, intake/output, mobility, falls, shift summary, handover, and patient education — and queues a clinician-reviewable draft. Never auto-changes orders or charts.',
    enabled: false,
    settings: {
      surface: 'clinical',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['NURSING_STAFF', 'DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'nursing_signoff',
      outputSchema: { type: 'object', required: ['shift_summary', 'wounds', 'drains', 'iv_lines', 'intake_output', 'mobility', 'falls'] },
      retentionDays: 365,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'ai_roi_dashboard',
    display_name: 'AI ROI Dashboard',
    description: 'Aggregates realized AI ROI — time saved per accepted draft, documentation hours saved, denial value prevented via appeal/prior-auth approvals, and cost per useful draft — from existing clinical AI tables. Read-only; never alters clinical decisions or billing.',
    enabled: true,
    settings: {
      surface: 'governance',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: false,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'IT_ADMIN', 'FINANCE_STAFF'],
      approvalPolicy: 'admin_readonly',
      outputSchema: { type: 'object', required: ['generation_count', 'accepted_count', 'time_saved_minutes', 'cost_per_useful_draft_minor'] },
      retentionDays: 1825,
      readOnlyDefault: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'appeal_letter_generator',
    display_name: 'Appeal Letter Generator for Denied Claims',
    description: 'Drafts a payer-specific appeal letter for a denied insurance claim from cited chart evidence. Billing/insurance coordinator reviews, edits, and submits; the module never auto-submits and tracks payer outcomes without automatic claim write-off.',
    enabled: false,
    settings: {
      surface: 'revenue_cycle',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BILLING_STAFF', 'INSURANCE_COORDINATOR', 'MEDICAL_RECORDS', 'ADMIN'],
      approvalPolicy: 'revenue_cycle_review',
      outputSchema: { type: 'object', required: ['cover_letter', 'medical_necessity', 'clinical_evidence', 'requested_action'] },
      retentionDays: 2555,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
    },
  },
  {
    module_key: 'patient_teach_back_comprehension',
    display_name: 'Patient Teach-Back / Comprehension AI',
    description: 'Post-discharge/aftercare patient comprehension loop: asks simple language-appropriate questions about medications, warning signs, follow-up, diet/activity, wound care, and emergency escalation, and flags misunderstandings for clinician review. Never alters care plans.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_review',
      outputSchema: { type: 'object', required: ['questions', 'comprehension_score', 'misunderstanding_flags'] },
      retentionDays: 1095,
      rulesAuthoritative: true,
      decisionSupportOnly: true,
      supported_languages: ['en', 'hi', 'ta', 'te', 'ml', 'mr', 'bn', 'kn'],
    },
  },
  {
    module_key: 'discharge_readiness',
    display_name: 'Discharge Readiness',
    description: 'Detects pending labs, unsigned notes, unresolved alerts, active orders, missing follow-up, and billing/documentation blockers.',
    enabled: false,
    settings: {
      surface: 'emr',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS', 'BILLING_STAFF'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: { type: 'object', required: ['ready', 'blockers', 'checklist'] },
      retentionDays: 180,
    },
  },
  {
    module_key: 'abnormal_result_triage',
    display_name: 'Abnormal Result Triage',
    description: 'Summarizes abnormal vitals, labs, and imaging and ranks urgency while leaving CDS/rules authoritative.',
    enabled: false,
    settings: {
      surface: 'clinical',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'LAB_STAFF', 'RADIOLOGY_STAFF'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: { type: 'object', required: ['urgent_items', 'watch_items', 'explanation'] },
      retentionDays: 180,
      // Differential interpretation of abnormal results benefits from the
      // deep tier and the bull/bear-style "pursue/challenge" debate.
      model_tier: 'deep',
      enableDifferentialDebate: true,
    },
  },
  {
    module_key: 'referral_letter',
    display_name: 'Referral Letter',
    description: 'Drafts transfer, referral, and second-opinion packets from cited chart context.',
    enabled: false,
    settings: {
      surface: 'referral',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_review',
      outputSchema: { type: 'object', required: ['reason_for_referral', 'clinical_summary', 'current_treatment'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'clinical_coding_assist',
    display_name: 'Clinical Coding Assistant',
    description: 'Suggests ICD/procedure/revenue-cycle codes from signed documentation only; coder/admin approval required.',
    enabled: false,
    settings: {
      surface: 'revenue_cycle',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BILLING_STAFF', 'MEDICAL_RECORDS', 'ADMIN'],
      approvalPolicy: 'coder_approval',
      outputSchema: {
        type: 'object',
        required: ['suggested_codes', 'evidence', 'coder_notes'],
        properties: {
          suggested_codes: { type: 'array', items: { type: 'object', required: ['system', 'code', 'validated'] } },
        },
      },
      retentionDays: 365,
    },
  },
  {
    module_key: 'clinician_ehr_query',
    display_name: 'Clinician EHR Query',
    description: 'Answers a clinician free-text question over a patient record (current admission + prior history), grounded + cited. Live answer, audit-logged, no review queue.',
    enabled: false,
    settings: {
      surface: 'clinical',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: [],
      approvalPolicy: 'none',
      outputSchema: {
        type: 'object',
        required: ['answer', 'citations'],
        properties: {
          answer: { type: 'string' },
          citations: { type: 'array' },
        },
      },
      retentionDays: 365,
    },
  },
  {
    module_key: 'ai_safety_reviewer',
    display_name: 'AI Safety Reviewer',
    description: 'Reviews AI outputs for unsupported claims, missing citations, medication/allergy risks, PHI leakage risk, and signoff status.',
    enabled: true,
    settings: {
      surface: 'governance',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'IT_ADMIN'],
      approvalPolicy: 'admin_it_control',
      outputSchema: { type: 'object', required: ['status', 'findings', 'citation_coverage_pct'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'denial_risk_assist',
    display_name: 'Denial Risk Assist',
    description: 'Identifies claim-denial documentation gaps, diagnosis/procedure mismatches, missing signatures, and missing evidence.',
    enabled: false,
    settings: {
      surface: 'billing',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BILLING_STAFF', 'MEDICAL_RECORDS', 'ADMIN'],
      approvalPolicy: 'revenue_cycle_review',
      outputSchema: { type: 'object', required: ['risk_level', 'gaps', 'recommended_actions'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'bed_discharge_forecast',
    display_name: 'Bed Discharge Forecast',
    description: 'Forecasts likely discharge in 24/48 hours and bed availability from clinical stability, pending work, LOS, and notes.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'],
      approvalPolicy: 'ops_review',
      outputSchema: { type: 'object', required: ['beds_available_now', 'likely_discharges_24h', 'likely_discharges_48h'] },
      retentionDays: 90,
    },
  },
  {
    module_key: 'pharmacy_stockout_predictor',
    display_name: 'Pharmacy Stockout Predictor',
    description: 'Forecasts drug consumption, reorder risk, high-usage meds, and batch recall exposure.',
    enabled: false,
    settings: {
      surface: 'pharmacy',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['PHARMACY_STAFF', 'ADMIN'],
      approvalPolicy: 'ops_review',
      outputSchema: { type: 'object', required: ['high_usage_meds', 'stockout_risks'] },
      retentionDays: 90,
    },
  },
  {
    module_key: 'quality_case_review',
    display_name: 'Quality Case Review',
    description: 'Summarizes incident, readmission, mortality, infection-control, grievance, and RCA packets.',
    enabled: false,
    settings: {
      surface: 'quality',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['QUALITY_STAFF', 'DOCTOR', 'ADMIN'],
      approvalPolicy: 'quality_review',
      outputSchema: { type: 'object', required: ['case_summary', 'timeline', 'open_questions'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'admin_policy_copilot',
    display_name: 'Admin Policy Copilot',
    description: 'Admin/IT-only query surface for AI governance status, audit history, enabled modules, external AI usage, and high-risk changes.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'IT_ADMIN'],
      approvalPolicy: 'admin_it_control',
      outputSchema: { type: 'object', required: ['answer', 'evidence'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'self_healing_bug_hunt',
    display_name: 'Self-Healing Bug Hunt Agent',
    description: 'Read-only troubleshooting and evolution surface that runs tests/scans, inspects logs, and opens issue/PR suggestions without silent production mutation.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'IT_ADMIN'],
      approvalPolicy: 'admin_it_control',
      outputSchema: { type: 'object', required: ['checks', 'findings', 'suggested_actions'] },
      retentionDays: 90,
      readOnlyDefault: true,
    },
  },
  {
    module_key: 'soap_from_dictation',
    display_name: 'SOAP from Dictation',
    description: 'Bedside dictation transcribed to a structured SOAP draft. Draft enters the review queue; clinician must confirm before it becomes part of the chart.',
    enabled: false,
    settings: {
      surface: 'clinical',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_signoff',
      outputSchema: { type: 'object', required: ['subjective', 'objective', 'assessment', 'plan'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'patient_communication_translation',
    display_name: 'Patient Communication Translation',
    description: 'Translates an accepted clinical AI draft into the patient\'s preferred language. Review-gated; only runs on reviewer-accepted drafts and verifies numeric/date/drug fidelity.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_review_required',
      outputSchema: { type: 'object' },
      retentionDays: 365,
      supported_languages: ['en', 'hi', 'ta', 'te', 'ml', 'mr', 'bn', 'kn'],
    },
  },
  {
    module_key: 'abdm_longitudinal_risk',
    display_name: 'ABDM Longitudinal Risk Score',
    description: 'Readmission risk card combining adherence ONNX/heuristic + local admission history + optional ABDM prior records. Decision support only; never auto-actions.',
    enabled: false,
    settings: {
      surface: 'emr',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'ADMIN'],
      approvalPolicy: 'clinician_review',
      outputSchema: { type: 'object', required: ['overall_score', 'band', 'contributors'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'appointment_no_show_predictor',
    display_name: 'Appointment No-Show Predictor',
    description: 'Per-appointment no-show risk score. Heuristic today; ONNX-ready. Never auto-cancels — feeds reminder workflow + overbooking.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: false,
      reviewRoles: ['ADMIN', 'RECEPTIONIST'],
      outputSchema: { type: 'object', required: ['risk_score', 'band'] },
      retentionDays: 90,
    },
  },
  {
    module_key: 'ot_case_time_predictor',
    display_name: 'OT Case-Time Predictor',
    description: 'Estimate OT duration from historical actual_duration windowed by surgeon + procedure. Confidence-weighted by sample size. Scheduler-only; surgeon can override.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: false,
      reviewRoles: ['OT_NURSE', 'OT_INCHARGE', 'OT_STAFF', 'ADMIN'],
      outputSchema: { type: 'object', required: ['predicted_minutes', 'confidence_pct'] },
      retentionDays: 180,
    },
  },
  {
    module_key: 'charge_capture_audit',
    display_name: 'Charge Capture Audit',
    description: 'Scans signed clinical notes for billable procedures not yet coded or invoiced. Coder confirms before charges are captured.',
    enabled: false,
    settings: {
      surface: 'revenue_cycle',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BILLING_STAFF', 'MEDICAL_RECORDS'],
      outputSchema: { type: 'object', required: ['missed_codes', 'estimated_revenue_minor'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'deterioration_early_warning',
    display_name: 'Deterioration Early Warning',
    description: 'Composite NEWS2-like score with vital trend + recent-lab components. Alerts before rule thresholds fire.',
    enabled: false,
    settings: {
      surface: 'clinical',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF'],
      outputSchema: { type: 'object', required: ['score', 'band', 'contributors'] },
      retentionDays: 90,
    },
  },
  {
    module_key: 'polypharmacy_ai_review',
    display_name: 'Polypharmacy AI Review',
    description: 'Rules + AI drug-interaction review. Rules authoritative; AI surfaces cross-class and QT-prolongation risks.',
    enabled: false,
    settings: {
      surface: 'pharmacy',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'PHARMACY_STAFF'],
      outputSchema: { type: 'object', required: ['combined_severity', 'rule_findings', 'ai_findings'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'clinical_trial_matcher',
    display_name: 'Clinical Trial Matcher',
    description: 'Matches current admissions against a tenant catalog of trials, ranked by condition overlap + eligibility. Coordinator decides.',
    enabled: false,
    settings: {
      surface: 'research',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['RESEARCH_COORDINATOR', 'ADMIN'],
      outputSchema: { type: 'object', required: ['matches'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'patient_record_chatbot',
    display_name: 'Patient Record Chatbot',
    description: 'Consent-gated RAG chatbot over the patient\'s OWN record. Never gives clinical advice.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['ADMIN'],
      outputSchema: { type: 'object' },
      retentionDays: 365,
    },
  },
  {
    module_key: 'rca_draft_generator',
    display_name: 'Mortality / RCA Draft Generator',
    description: 'Auto-generates candidate RCA findings from the chart. Always draft; committee signs off.',
    enabled: false,
    settings: {
      surface: 'quality',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['QUALITY_OFFICER', 'DOCTOR', 'ADMIN'],
      outputSchema: { type: 'object', required: ['timeline', 'candidate_findings', 'contributing_factors'] },
      retentionDays: 1825,
    },
  },
  {
    module_key: 'prior_authorization_generator',
    display_name: 'Prior Authorization Generator',
    description: 'Auto-assembles a payer-specific pre-auth packet from the chart with evidence + citations. Billing reviews and submits.',
    enabled: false,
    settings: {
      surface: 'revenue_cycle',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BILLING_STAFF', 'INSURANCE_COORDINATOR', 'ADMIN'],
      outputSchema: { type: 'object', required: ['medical_necessity', 'clinical_evidence', 'procedure_code'] },
      retentionDays: 2555,
    },
  },
  {
    module_key: 'radiology_ai_interpretation',
    display_name: 'Radiology AI Interpretation',
    description: 'DICOM study + external-model inference produces a radiologist draft. Critical findings fast-track; radiologist signs off.',
    enabled: false,
    settings: {
      surface: 'radiology',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['RADIOLOGIST', 'DOCTOR', 'ADMIN'],
      approvalPolicy: 'radiologist_signoff',
      outputSchema: { type: 'object', required: ['findings', 'overall_severity', 'narrative_draft'] },
      retentionDays: 3650,
    },
  },
  {
    module_key: 'document_intelligence_ocr',
    display_name: 'Document Intelligence / OCR',
    description: 'Extracts structured clinical facts from uploaded or externally OCRed documents. Medical-records or clinician review is required before any chart import.',
    enabled: false,
    settings: {
      surface: 'medical_records',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['MEDICAL_RECORDS', 'DOCTOR', 'NURSING_STAFF'],
      approvalPolicy: 'clinical_document_review',
      outputSchema: { type: 'object', required: ['document_type', 'extracted_fields', 'normalized_sections'] },
      uploadPipeline: true,
      ocrAdapters: {
        nativeText: true,
        nativePdfText: true,
        localTesseract: true,
        localPdfText: true,
      },
      retentionDays: 3650,
    },
  },
  {
    module_key: 'chart_completion_auditor',
    display_name: 'Chart Completion Auditor',
    description: 'Scores admission chart completeness and highlights unsigned notes, missing identifiers, pending investigations, active orders, missing discharge artefacts, and review blockers.',
    enabled: false,
    settings: {
      surface: 'medical_records',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['MEDICAL_RECORDS', 'DOCTOR', 'NURSING_STAFF', 'BILLING_STAFF'],
      approvalPolicy: 'chart_gap_review',
      outputSchema: { type: 'object', required: ['completion_score', 'risk_band', 'gaps', 'recommendations'] },
      retentionDays: 3650,
    },
  },
  {
    module_key: 'consent_phi_policy_sentinel',
    display_name: 'Consent & PHI Policy Sentinel',
    description: 'Audits AI generations for active consent, external-provider boundaries, PHI exposure, missing citations, safety flags, and stale human review.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: false,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'IT_ADMIN', 'COMPLIANCE_OFFICER'],
      approvalPolicy: 'privacy_governance_review',
      outputSchema: { type: 'object', required: ['risk_score', 'risk_band', 'findings', 'consent_snapshot'] },
      retentionDays: 3650,
    },
  },
  {
    module_key: 'clinical_text_deidentifier',
    display_name: 'Clinical Text De-identifier',
    description: 'Deterministically removes PHI from clinical free text (chart-anchored identifiers + structured-identifier regex), producing best-effort de-identified text plus a residual-risk report. Not a Safe-Harbor certification.',
    enabled: false,
    settings: {
      surface: 'governance',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: false,
      reviewRoles: ['ADMIN', 'SUPER_ADMIN', 'COMPLIANCE_OFFICER'],
      approvalPolicy: 'privacy_governance_review',
      outputSchema: { type: 'object', required: ['text', 'redactions'] },
      retentionDays: 3650,
    },
  },
  {
    module_key: 'infection_control_sentinel',
    display_name: 'Infection Control Sentinel',
    description: 'Flags possible HAI, isolation, culture, and antimicrobial-stewardship risks from cited inpatient chart evidence for infection-control review.',
    enabled: false,
    settings: {
      surface: 'infection_control',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['INFECTION_CONTROL', 'DOCTOR', 'NURSING_STAFF', 'PHARMACIST', 'ADMIN'],
      approvalPolicy: 'infection_control_review',
      outputSchema: { type: 'object', required: ['risk_score', 'risk_band', 'signals', 'recommendations'] },
      retentionDays: 3650,
    },
  },
  {
    module_key: 'sepsis_bundle_sentinel',
    display_name: 'Sepsis Bundle Sentinel',
    description: 'Audits suspected sepsis bundle completion from cited vitals, lactate/culture evidence, antibiotics, fluids, and vasopressor signals.',
    enabled: false,
    settings: {
      surface: 'clinical_safety',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'ICU_TEAM', 'ADMIN'],
      approvalPolicy: 'sepsis_bundle_review',
      outputSchema: { type: 'object', required: ['risk_score', 'risk_band', 'criteria', 'bundle_gaps', 'recommendations'] },
      retentionDays: 3650,
    },
  },
  {
    module_key: 'virtual_ward_triage',
    display_name: 'Virtual Ward Triage',
    description: 'Post-discharge daily symptom + wearable check-in pipeline. Auto-triages green/amber/red and queues red escalations for care manager.',
    enabled: false,
    settings: {
      surface: 'virtual_ward',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'ADMIN'],
      outputSchema: { type: 'object', required: ['triage_band', 'triage_reasons'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'ambient_visit_documentation',
    display_name: 'Ambient Visit Documentation',
    description: 'Multi-speaker encounter transcript → structured visit note with speaker attribution. Consent-gated; clinician signs off.',
    enabled: false,
    settings: {
      surface: 'clinical',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_signoff',
      outputSchema: { type: 'object', required: ['chief_complaint', 'hpi', 'assessment', 'plan'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'staff_roster_optimizer',
    display_name: 'Staff Roster Optimizer',
    description: 'Advisory scheduler and leave-clustering forecast from historical demand, leave reasons, calendar, commute, and weather signals. Manager reviews before use.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      reviewRoles: ['ADMIN', 'HR_STAFF', 'DEPARTMENT_HEAD'],
      outputSchema: { type: 'object', required: ['assignments', 'coverage_gaps', 'preference_conflicts', 'leave_forecast'] },
      retentionDays: 365,
      decisionSupportOnly: true,
      forecastWindowDays: 84,
    },
  },
  // ── Tier A patient explainers ────────────────────────────────────────────
  // Five thin "explain X to the patient in plain language" wrappers added in
  // the same session as Phase A1 KB CRUD. Each leverages the new KB
  // retrieval surface so hospital-specific reference material can be cited
  // (e.g. lab reference ranges from the formulary KB). Decision-support
  // only; clinician signs off before patient sees anything.
  {
    module_key: 'lab_patient_explanation',
    display_name: 'Lab Result Patient Explanation',
    description: 'Plain-language explanation of a single lab result for the patient: what each value means, whether it is in range, what to ask the doctor, and red-flag symptoms that warrant urgent contact.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'LAB_STAFF', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_signoff',
      outputSchema: { type: 'object', required: ['explanation_summary', 'key_points'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'radiology_patient_explanation',
    display_name: 'Radiology Patient Explanation',
    description: 'Plain-language explanation of a radiology report for the patient: what the imaging showed, severity in lay terms, follow-up imaging or referrals needed, and red-flag symptoms.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'RADIOLOGIST', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_signoff',
      outputSchema: { type: 'object', required: ['explanation_summary', 'key_points'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'patient_report_explainer',
    display_name: 'Generic Patient Report Explainer',
    description: 'Generic plain-language explanation of any clinical document the patient receives (consultation note, discharge note, procedure report). Used when no specialised explainer covers the input.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_signoff',
      outputSchema: { type: 'object', required: ['explanation_summary', 'key_points'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'prescription_patient_explainer',
    display_name: 'Prescription Patient Explainer',
    description: 'Plain-language explanation of a prescription: what each medication is for, dosing instructions, common side effects to watch for, interactions to avoid, and red-flag symptoms.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'PHARMACY_STAFF', 'MEDICAL_RECORDS'],
      approvalPolicy: 'clinician_signoff',
      outputSchema: { type: 'object', required: ['explanation_summary', 'key_points'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'invoice_patient_explainer',
    display_name: 'Invoice Patient Explainer',
    description: 'Plain-language explanation of a hospital invoice: what each line item is, what the patient owes vs insurance, how to dispute charges, and where to ask for an itemised estimate.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['BILLING_STAFF', 'INSURANCE_COORDINATOR', 'ADMIN'],
      approvalPolicy: 'billing_review',
      outputSchema: { type: 'object', required: ['explanation_summary', 'key_points'] },
      retentionDays: 365,
    },
  },
  {
    module_key: 'preop_checklist_review',
    display_name: 'Pre-Op Checklist Review',
    description: 'Reviews a preop_checklists row for completeness against case context: consent signed, NPO confirmed, site marked, allergies reviewed, blood arranged, antibiotic prophylaxis selection vs procedure type, imaging available. Surfaces missing items with rationale; never auto-completes the checklist.',
    enabled: false,
    settings: {
      surface: 'theatre',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF', 'ANESTHETIST'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: {
        type: 'object',
        required: ['readiness_status', 'missing_items', 'recommendations'],
      },
      retentionDays: 365,
      model_tier: 'deep',
    },
  },
  {
    module_key: 'surgical_consent_draft',
    display_name: 'Surgical Consent Draft',
    description: 'Drafts a procedure-specific informed-consent document: indication, alternatives, risks tied to the patient\'s comorbidities, expected benefits, anesthesia implications, post-op course. Always cited from clinical evidence and hospital protocol; surgeon must edit + sign.',
    enabled: false,
    settings: {
      surface: 'theatre',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: {
        type: 'object',
        required: ['indication', 'alternatives', 'risks', 'benefits', 'plain_language_summary'],
      },
      retentionDays: 365,
      model_tier: 'deep',
    },
  },
  {
    module_key: 'ot_note_draft',
    display_name: 'Operative Note Draft',
    description: 'Drafts a structured operative note from the case context (procedure performed, surgeon, technique, intraoperative findings, EBL, counts, drains, closure). Surgeon edits and signs through the existing review queue; we never auto-finalize.',
    enabled: false,
    settings: {
      surface: 'theatre',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: {
        type: 'object',
        required: ['procedure_performed', 'findings', 'technique', 'closure'],
      },
      retentionDays: 365,
      model_tier: 'deep',
    },
  },
  {
    module_key: 'post_op_instruction_draft',
    display_name: 'Post-Op Instruction Draft',
    description: 'Drafts patient-facing post-operative instructions in plain language: wound care, diet advancement, activity restrictions, pain management, signs that need urgent attention, follow-up appointments. Tailored to procedure performed.',
    enabled: false,
    settings: {
      surface: 'patient',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF'],
      approvalPolicy: 'clinician_review',
      outputSchema: {
        type: 'object',
        required: ['wound_care', 'medications', 'activity', 'warning_signs', 'follow_up'],
      },
      retentionDays: 365,
    },
  },
  {
    module_key: 'surgical_risk_summary',
    display_name: 'Surgical Risk Summary',
    description: 'Patient-specific surgical risk summary integrating ASA grade, comorbidities, prior anesthesia events, lab abnormalities, anticoagulation, frailty markers. Returns risk bands with citation to evidence and any flags requiring optimisation before proceeding.',
    enabled: false,
    settings: {
      surface: 'theatre',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'ANESTHETIST'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: {
        type: 'object',
        required: ['risk_band', 'risk_factors', 'recommendations'],
      },
      retentionDays: 365,
      model_tier: 'deep',
    },
  },
  {
    module_key: 'anesthesia_precheck_assistant',
    display_name: 'Anesthesia Pre-Check Assistant',
    description: 'Drafts a pre-anesthesia evaluation: airway assessment summary, ASA grading rationale, drug-allergy interactions, anticoagulation hold timing, fasting clearance, PONV risk + prophylaxis, anesthesia plan recommendation. Anesthetist signs through the review queue.',
    enabled: false,
    settings: {
      surface: 'theatre',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['ANESTHETIST', 'DOCTOR'],
      approvalPolicy: 'two_person_for_enablement',
      outputSchema: {
        type: 'object',
        required: ['asa_assessment', 'airway_plan', 'medication_plan', 'fasting_status', 'risks'],
      },
      retentionDays: 365,
      model_tier: 'deep',
    },
  },
  {
    module_key: 'implant_consumable_tracker',
    display_name: 'Implant + Consumable Tracker',
    description: 'Reconciles intraoperatively documented implants and high-cost consumables against inventory + procurement records, manufacturer recall feeds, and expiry data. Surfaces missing UDIs, expired stock used, or recalled lots used.',
    enabled: false,
    settings: {
      surface: 'theatre',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: false,
      requiresCitations: true,
      reviewRoles: ['MATERIALS_MANAGER', 'NURSING_STAFF', 'ADMIN'],
      approvalPolicy: 'materials_review',
      outputSchema: {
        type: 'object',
        required: ['reconciliation', 'flags'],
      },
      retentionDays: 365,
    },
  },
  {
    module_key: 'post_op_complication_alert',
    display_name: 'Post-Op Complication Alert',
    description: 'Surgery-specific complication detection from postop_notes + vitals + labs + imaging: anastomotic leak, deep SSI, return-to-theatre indicators, reintubation risk, DVT/PE, MI, AKI, sepsis. Distinct from generic deterioration — focused on operative recovery patterns.',
    enabled: false,
    settings: {
      surface: 'theatre',
      risk: 'critical',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR', 'NURSING_STAFF'],
      approvalPolicy: 'clinician_review',
      outputSchema: {
        type: 'object',
        required: ['complication_signals', 'severity', 'recommended_action'],
      },
      retentionDays: 365,
      model_tier: 'deep',
    },
  },
  {
    module_key: 'teleconsult_pre_visit_summary',
    display_name: 'Teleconsult Pre-Visit Summary',
    description: 'Builds a 60-second pre-visit summary the doctor reads before joining a teleconsult: chief complaint, current medications, relevant history, recent vitals, suggested questions, red flags. Loaded from pre_consult_form + patient context.',
    enabled: false,
    settings: {
      surface: 'telemedicine',
      risk: 'medium',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'clinician_review',
      outputSchema: {
        type: 'object',
        required: ['chief_complaint', 'suggested_questions', 'red_flags'],
      },
      retentionDays: 180,
    },
  },
  {
    module_key: 'teleconsult_note_draft',
    display_name: 'Teleconsult Note Draft',
    description: 'Drafts a structured SOAP-style note from the teleconsult chat transcript + chief complaint. Acknowledges the limited objective exam in remote care (writes "no objective exam — video only" when appropriate). Doctor edits and signs through the review queue.',
    enabled: false,
    settings: {
      surface: 'telemedicine',
      risk: 'high',
      status: 'available',
      requiresClinicianSignoff: true,
      requiresCitations: true,
      reviewRoles: ['DOCTOR'],
      approvalPolicy: 'doctor_signoff',
      outputSchema: {
        type: 'object',
        required: ['subjective', 'assessment', 'plan'],
      },
      retentionDays: 365,
      model_tier: 'deep',
    },
  },
];

export const DEFAULT_CLINICAL_AI_GUARDRAILS = {
  id: 1,
  enabled: true,
  external_ai_enabled: true,
  daily_token_limit: null,
  daily_cost_limit_minor: null,
  request_token_limit: null,
  fallback_rate_alert_pct: 50,
  max_fallbacks_per_day: null,
  latency_alert_ms: 15000,
  updated_by: null,
  created_at: null,
  updated_at: null,
};

const MODULE_CACHE_MS = 30_000;
const DEFAULT_EVAL_GATE_MAX_AGE_DAYS = 30;
const DEFAULT_EVAL_GATE_MAX_SAFETY_RATE_PCT = 2;
const DEFAULT_EVAL_GATE_MODEL = 'llama3.1:8b';
const EVAL_GATE_BLOCKING_RECOMMENDATIONS = new Set(['rollback', 'retire', 'quarantine']);
const EVAL_GATE_BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const MODULE_APPROVAL_TYPE = 'module_governance_change';
const MODULE_SEED_LOCK_KEY = 7427132401;
const RISKY_MODULE_FIELDS = [
  'enabled',
  'external_allowed',
  'provider_override',
  'model_override',
  'max_tokens',
  'temperature',
];
let moduleCache = null;
let moduleCacheAt = 0;
let guardrailCache = null;
let guardrailCacheAt = 0;
let moduleSeedPromise = null;

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist|invalid_schema_name/i.test(
    String(err?.message || '')
  );
}

function emptySafetyReviewSummary(windowDays, reason = null) {
  return {
    window_days: windowDays,
    reason,
    overall: {
      review_count: 0,
      passed_count: 0,
      needs_review_count: 0,
      blocked_count: 0,
      avg_citation_coverage_pct: null,
      low_citation_count: 0,
      finding_count: 0,
      high_or_critical_finding_count: 0,
      last_review_at: null,
    },
    by_module: [],
    recent_findings: [],
  };
}

function sanitizeModuleKey(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
}

function defaultModuleFor(moduleKey) {
  const key = sanitizeModuleKey(moduleKey);
  // Registered modules return their declared config verbatim — flipping the
  // fallback below does NOT change any registered module's behaviour.
  // For an UNREGISTERED key we must fail safe: an unknown module is not a
  // governed, enabled module. Returning enabled:true here previously let a
  // typo'd / never-registered moduleKey bypass the enable gate AND the
  // safety knobs (it inherited no reviewRoles, no signoff, no citations
  // requirement). The safe default is enabled:false + clinician signoff +
  // citations required, so an unknown key can never silently generate or
  // reach a reviewer as an "acceptable" draft. (AI-1, WS5 B5.1.)
  return CLINICAL_AI_MODULES.find((module) => module.module_key === key) || {
    module_key: key,
    display_name: key || 'Unknown module',
    description: null,
    enabled: false,
    provider_override: null,
    model_override: null,
    external_allowed: false,
    max_tokens: null,
    temperature: null,
    settings: {
      requiresClinicianSignoff: true,
      requiresCitations: true,
    },
  };
}

function isNil(value) {
  return value === null || value === undefined;
}

function nullableInt(value) {
  if (value === '' || isNil(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const parsed = nullableInt(value);
  if (parsed === null) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function schemaUnavailableError(err, surface) {
  if (!isMissingSchemaError(err)) return err;
  logger.warn('Clinical AI governance schema unavailable', {
    surface,
    error: err.message,
  });
  return AppError.internal(
    'Clinical AI governance schema is unavailable; refusing unsafe fallback',
    'CLINICAL_AI_SCHEMA_UNAVAILABLE'
  );
}

function normalizeProviderName(value) {
  const provider = String(value || 'template').toLowerCase().trim();
  const aliases = {
    local: 'ollama',
    'llama-local': 'ollama',
    llama: 'ollama',
    openai_compatible: 'openai-compatible',
    openai_compat: 'openai-compatible',
    compatible: 'openai-compatible',
    chatgpt: 'openai',
    claude: 'anthropic',
  };
  return aliases[provider] || provider;
}

function tieredEnvValue(module, suffix) {
  const tier = String(module?.settings?.model_tier || module?.settings?.modelTier || '').toLowerCase();
  if (tier === 'deep') {
    const deepValue = process.env[`CLINICAL_AI_DEEP_${suffix}`];
    if (deepValue !== undefined && deepValue !== '') return deepValue;
  }
  return process.env[`CLINICAL_AI_${suffix}`] || '';
}

function resolveEffectiveProviderModel(module) {
  return {
    provider: normalizeProviderName(
      module?.provider_override
        || tieredEnvValue(module, 'PROVIDER')
        || process.env.AI_PROVIDER
        || 'template'
    ),
    model: String(
      module?.model_override
        || tieredEnvValue(module, 'MODEL')
        || process.env.AI_SUMMARIZE_MODEL
        || DEFAULT_EVAL_GATE_MODEL
    ).trim(),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableJson(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function hashRequestedChange(change) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJson(change || {})))
    .digest('hex');
}

function normalizeComparable(value) {
  if (value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  return String(value).trim();
}

function valuesDiffer(left, right) {
  return normalizeComparable(left) !== normalizeComparable(right);
}

function moduleRisk(module) {
  return String(module?.settings?.risk || '').toLowerCase();
}

function moduleApprovalPolicy(module) {
  return String(module?.settings?.approvalPolicy || '').toLowerCase();
}

function moduleSurface(module) {
  return String(module?.settings?.surface || '').toLowerCase().trim();
}

function isPatientSurface(module) {
  return moduleSurface(module) === 'patient';
}

// Safety-classification settings that describe WHAT a module is — its audience
// and risk posture. They are declared in code (the base module catalog) and are
// the source of truth for the enablement guards (assertPatientSurfaceEnablement
// reads settings.surface). A tenant override must NEVER be able to reclassify a
// module — e.g. flip a patient-facing module's surface to 'staff' to slip past
// the patient-surface clearance, or downgrade its risk (audit 2026-06-22 M14).
// These keys are stripped from any caller-supplied settings and always resolved
// from the base definition.
const IMMUTABLE_MODULE_SETTING_KEYS = Object.freeze([
  'surface',
  'risk',
  'patientFacing',
  'decisionSupportOnly',
  'rulesAuthoritative',
]);

function stripImmutableModuleSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  for (const key of IMMUTABLE_MODULE_SETTING_KEYS) delete out[key];
  return out;
}

/**
 * Patient-surface enablement guard (audit 2026-06-18 §3 /
 * CLINICAL_AI_ENABLEMENT_PLAN.md). Patient-facing AI must stay OFF until it is
 * explicitly cleared, so no module whose registry `settings.surface === 'patient'`
 * may be toggled into an ENABLED state through the normal enable path.
 *
 * Fires only on the OFF→ON transition for a patient-surface module, and only
 * when no explicit override flag is present. A disable (enabled:false) or a
 * no-op is never blocked. Throws AppError.forbidden with a clear code so the
 * route surfaces a 403 instead of a generic 500.
 *
 * Escape hatch: pass `allow_patient_surface: true` (or `allowPatientSurface`)
 * in the update payload to deliberately enable a cleared patient surface. The
 * two-person / eval gates still apply on top of the override.
 *
 * @param {object} args
 * @param {object} args.current  current (effective) module config
 * @param {object} args.next     proposed (effective) module config
 * @param {object} args.data     raw update payload (carries the override flag)
 */
function assertPatientSurfaceEnablementAllowed({ current, next, data = {} }) {
  const enablingNow = !current?.enabled && next?.enabled === true;
  if (!enablingNow) return;
  if (!isPatientSurface(next)) return;
  const override = data.allow_patient_surface === true || data.allowPatientSurface === true;
  if (override) return;
  throw AppError.forbidden(
    'Patient-facing clinical AI modules cannot be enabled until patient surfaces are explicitly cleared',
    'CLINICAL_AI_PATIENT_SURFACE_FORBIDDEN',
    { module_key: next?.module_key || current?.module_key || null, surface: 'patient' }
  );
}

function riskyChangedFields(current, next) {
  return RISKY_MODULE_FIELDS.filter((field) => valuesDiffer(current?.[field], next?.[field]));
}

function changeRequiresApproval(current, next, changedFields) {
  const risk = moduleRisk(next);
  const approvalPolicy = moduleApprovalPolicy(next);
  const enabledNow = !current?.enabled && next?.enabled && changedFields.includes('enabled');
  const reasons = [];

  if (enabledNow && (approvalPolicy === 'two_person_for_enablement' || ['high', 'critical'].includes(risk))) {
    reasons.push('two_person_enablement');
  }

  for (const field of changedFields.filter((field) => field !== 'enabled')) {
    reasons.push(`risky_runtime_change:${field}`);
  }

  return reasons;
}

function changeRequiresEval(current, next, changedFields) {
  const risk = moduleRisk(next);
  const enablingHighRisk = !current?.enabled && next?.enabled && ['high', 'critical'].includes(risk);
  const externalOrModelChange = changedFields.some((field) => (
    field === 'external_allowed' || field === 'provider_override' || field === 'model_override'
  ));
  return enablingHighRisk || externalOrModelChange;
}

function moduleChangePayload({ scope, tenantId, moduleKey, actorUid, changedFields, current, next, reasons, evalGate }) {
  const payload = {
    scope,
    tenant_id: requireTenantId(tenantId),
    module_key: moduleKey,
    changed_fields: changedFields,
    current: Object.fromEntries(RISKY_MODULE_FIELDS.map((field) => [field, current?.[field] ?? null])),
    next: Object.fromEntries(RISKY_MODULE_FIELDS.map((field) => [field, next?.[field] ?? null])),
    reasons,
    eval_gate: evalGate || null,
  };
  const changeHash = hashRequestedChange(payload);
  return {
    ...payload,
    requested_by: actorUid || null,
    requested_change_hash: changeHash,
  };
}

async function readApprovedModuleChangeApproval({ tenantId, approvalId, moduleKey, requestedChangeHash }) {
  if (!approvalId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, approval_type, module_key, status, requested_by, approved_by,
              rejected_by, reason, payload, expires_at, decided_at, created_at
       FROM clinical_ai_approvals
       WHERE id = $1
         AND tenant_id = $2::uuid
         AND module_key = $3
       LIMIT 1`,
      Number.parseInt(approvalId, 10),
      requireTenantId(tenantId),
      moduleKey
    );
    const approval = rows[0] || null;
    if (!approval) {
      throw AppError.forbidden('Approved Clinical AI module-change approval was not found', 'CLINICAL_AI_APPROVAL_NOT_FOUND');
    }
    if (approval.status !== 'approved') {
      throw AppError.forbidden('Clinical AI module-change approval is not approved', 'CLINICAL_AI_APPROVAL_NOT_APPROVED');
    }
    if (approval.approval_type !== MODULE_APPROVAL_TYPE) {
      throw AppError.forbidden('Clinical AI approval type does not match module governance change', 'CLINICAL_AI_APPROVAL_MISMATCH');
    }
    if (approval.expires_at && new Date(approval.expires_at).getTime() < Date.now()) {
      throw AppError.forbidden('Clinical AI module-change approval has expired', 'CLINICAL_AI_APPROVAL_EXPIRED');
    }
    if (approval.requested_by && approval.approved_by && approval.requested_by === approval.approved_by) {
      throw AppError.forbidden('Two-person approval cannot be self-approved', 'CLINICAL_AI_APPROVAL_SELF_APPROVED');
    }
    if (approval.payload?.requested_change_hash !== requestedChangeHash) {
      throw AppError.forbidden('Clinical AI approval does not match the requested module change', 'CLINICAL_AI_APPROVAL_MISMATCH');
    }
    return approval;
  } catch (err) {
    throw schemaUnavailableError(err, 'module_change_approval_lookup');
  }
}

async function createPendingModuleChangeApproval({ tenantId, moduleKey, requestedBy, requestedChange }) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_approvals
         (tenant_id, approval_type, module_key, status, requested_by, reason, payload, expires_at, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, 'pending', $4::uuid, $5, $6::jsonb, NOW() + INTERVAL '7 days', NOW(), NOW())
       RETURNING id, approval_type, module_key, status, requested_by, reason, payload, expires_at, created_at`,
      requireTenantId(tenantId),
      MODULE_APPROVAL_TYPE,
      moduleKey,
      requestedBy || null,
      `Approve Clinical AI governance change for ${moduleKey}`,
      JSON.stringify(requestedChange)
    );
    return rows[0];
  } catch (err) {
    throw schemaUnavailableError(err, 'module_change_approval_create');
  }
}

async function assertAcceptedEvalGate({ tenantId, moduleKey, module, guardrails }) {
  const { provider, model } = resolveEffectiveProviderModel(module);
  const maxAgeDays = Math.min(
    Math.max(Number.parseInt(process.env.CLINICAL_AI_EVAL_GATE_MAX_AGE_DAYS, 10) || DEFAULT_EVAL_GATE_MAX_AGE_DAYS, 1),
    365
  );
  const fallbackThreshold = clampInt(
    guardrails?.fallback_rate_alert_pct,
    { min: 0, max: 100, fallback: DEFAULT_CLINICAL_AI_GUARDRAILS.fallback_rate_alert_pct }
  );
  const safetyThreshold = Number.isFinite(Number(process.env.CLINICAL_AI_EVAL_GATE_MAX_SAFETY_RATE_PCT))
    ? Number(process.env.CLINICAL_AI_EVAL_GATE_MAX_SAFETY_RATE_PCT)
    : DEFAULT_EVAL_GATE_MAX_SAFETY_RATE_PCT;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, model_key, version, suite, recommendation, severity,
              fallback_rate_pct, safety_flag_rate_pct, reviewer_decision,
              metadata, created_at
       FROM clinical_ai_model_eval_runs
       WHERE tenant_id = $1::uuid
         AND reviewer_decision = 'accepted'
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
         AND COALESCE(metadata->>'module_key', model_key) = $3
         AND COALESCE(metadata->>'provider', '') = $4
         AND COALESCE(metadata->>'model', version, '') = $5
       ORDER BY created_at DESC
       LIMIT 1`,
      requireTenantId(tenantId),
      maxAgeDays,
      moduleKey,
      provider,
      model
    );
    const row = rows[0] || null;
    if (!row) {
      throw AppError.forbidden(
        'Accepted Clinical AI eval run is required before this governance change',
        'CLINICAL_AI_EVAL_GATE_REQUIRED',
        { module_key: moduleKey, provider, model, max_age_days: maxAgeDays }
      );
    }

    const recommendation = String(row.recommendation || '').toLowerCase();
    const severity = String(row.severity || '').toLowerCase();
    const fallbackRate = Number(row.fallback_rate_pct ?? 0);
    const safetyRate = Number(row.safety_flag_rate_pct ?? 0);
    const breaches = [];
    if (EVAL_GATE_BLOCKING_RECOMMENDATIONS.has(recommendation)) breaches.push(`recommendation:${recommendation}`);
    if (EVAL_GATE_BLOCKING_SEVERITIES.has(severity)) breaches.push(`severity:${severity}`);
    if (Number.isFinite(fallbackRate) && fallbackRate >= fallbackThreshold) breaches.push(`fallback_rate:${fallbackRate}`);
    if (Number.isFinite(safetyRate) && safetyRate >= safetyThreshold) breaches.push(`safety_flag_rate:${safetyRate}`);
    if (breaches.length) {
      throw AppError.forbidden(
        'Latest accepted Clinical AI eval run does not satisfy enablement gate',
        'CLINICAL_AI_EVAL_GATE_FAILED',
        { module_key: moduleKey, provider, model, eval_run_id: row.id, breaches }
      );
    }

    return {
      eval_run_id: row.id,
      provider,
      model,
      max_age_days: maxAgeDays,
      fallback_rate_pct: fallbackRate,
      safety_flag_rate_pct: safetyRate,
    };
  } catch (err) {
    throw schemaUnavailableError(err, 'module_change_eval_gate');
  }
}

function normalizeModule(row) {
  return {
    module_key: row.module_key,
    display_name: row.display_name,
    description: row.description,
    enabled: Boolean(row.enabled),
    provider_override: row.provider_override || null,
    model_override: row.model_override || null,
    external_allowed: Boolean(row.external_allowed),
    max_tokens: isNil(row.max_tokens) ? null : Number(row.max_tokens),
    temperature: isNil(row.temperature) ? null : Number(row.temperature),
    settings: row.settings || {},
    updated_by: row.updated_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function normalizeGuardrails(row = DEFAULT_CLINICAL_AI_GUARDRAILS) {
  return {
    id: 1,
    enabled: Boolean(row.enabled),
    external_ai_enabled: row.external_ai_enabled !== false,
    daily_token_limit: nullableInt(row.daily_token_limit),
    daily_cost_limit_minor: nullableInt(row.daily_cost_limit_minor),
    request_token_limit: nullableInt(row.request_token_limit),
    fallback_rate_alert_pct: clampInt(row.fallback_rate_alert_pct, { min: 0, max: 100, fallback: 50 }),
    max_fallbacks_per_day: nullableInt(row.max_fallbacks_per_day),
    latency_alert_ms: clampInt(row.latency_alert_ms, { min: 1000, max: 300000, fallback: 15000 }),
    updated_by: row.updated_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function mergeDefaultWithRow(defaultModule, row) {
  if (!row) return normalizeModule(defaultModule);
  return normalizeModule({
    ...defaultModule,
    ...row,
    settings: {
      ...(defaultModule.settings || {}),
      ...(row.settings || {}),
    },
  });
}

function hasOverrideValue(value) {
  return value !== null && value !== undefined;
}

function normalizeTenantOverride(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    tenant_id: row.tenant_id || null,
    module_key: row.module_key || null,
    enabled: hasOverrideValue(row.enabled) ? Boolean(row.enabled) : null,
    provider_override: row.provider_override || null,
    model_override: row.model_override || null,
    external_allowed: hasOverrideValue(row.external_allowed) ? Boolean(row.external_allowed) : null,
    max_tokens: isNil(row.max_tokens) ? null : Number(row.max_tokens),
    temperature: isNil(row.temperature) ? null : Number(row.temperature),
    settings: row.settings || {},
    updated_by: row.updated_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function applyTenantOverride(module, overrideRow, tenantId) {
  const base = normalizeModule(module);
  const override = normalizeTenantOverride(overrideRow);
  if (!override) {
    return {
      ...base,
      tenant_id: tenantId || null,
      tenant_override_id: null,
      tenant_override_source: 'global',
      global_enabled: base.enabled,
      global_provider_override: base.provider_override,
      global_model_override: base.model_override,
      global_external_allowed: base.external_allowed,
      tenant_overrides: null,
    };
  }

  const merged = normalizeModule({
    ...base,
    enabled: hasOverrideValue(override.enabled) ? override.enabled : base.enabled,
    provider_override: hasOverrideValue(override.provider_override)
      ? override.provider_override
      : base.provider_override,
    model_override: hasOverrideValue(override.model_override)
      ? override.model_override
      : base.model_override,
    external_allowed: hasOverrideValue(override.external_allowed)
      ? override.external_allowed
      : base.external_allowed,
    max_tokens: hasOverrideValue(override.max_tokens) ? override.max_tokens : base.max_tokens,
    temperature: hasOverrideValue(override.temperature) ? override.temperature : base.temperature,
    settings: {
      ...(base.settings || {}),
      ...(override.settings || {}),
    },
    updated_by: override.updated_by || base.updated_by,
    created_at: base.created_at,
    updated_at: override.updated_at || base.updated_at,
  });

  return {
    ...merged,
    tenant_id: override.tenant_id || tenantId || null,
    tenant_override_id: override.id,
    tenant_override_source: 'tenant',
    global_enabled: base.enabled,
    global_provider_override: base.provider_override,
    global_model_override: base.model_override,
    global_external_allowed: base.external_allowed,
    tenant_overrides: {
      enabled: override.enabled,
      provider_override: override.provider_override,
      model_override: override.model_override,
      external_allowed: override.external_allowed,
      max_tokens: override.max_tokens,
      temperature: override.temperature,
      settings: override.settings || {},
      updated_by: override.updated_by,
      updated_at: override.updated_at,
    },
  };
}

async function upsertMissingModules(client = prisma) {
  for (const module of CLINICAL_AI_MODULES) {
    const settingsJson = JSON.stringify(module.settings || {});
    const updated = await executeRawWrite(
      client,
      `UPDATE clinical_ai_modules
          SET display_name = $2,
              description = $3,
              settings = settings || $4::jsonb,
              updated_at = NOW()
        WHERE module_key = $1`,
      module.module_key,
      module.display_name,
      module.description,
      settingsJson
    );
    if (Number(updated) > 0) continue;

    await executeRawWrite(
      client,
      `INSERT INTO clinical_ai_modules
         (module_key, display_name, description, enabled, settings, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
       ON CONFLICT ON CONSTRAINT clinical_ai_modules_pkey
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         settings = clinical_ai_modules.settings || EXCLUDED.settings,
         updated_at = NOW()`,
      module.module_key,
      module.display_name,
      module.description,
      module.enabled,
      settingsJson
    );
  }
}

async function executeRawWrite(client, sql, ...params) {
  if (typeof client.$executeRawUnsafe === 'function') {
    return client.$executeRawUnsafe(sql, ...params);
  }
  return client.$queryRawUnsafe(sql, ...params);
}

async function seedMissingModules() {
  if (moduleSeedPromise) return moduleSeedPromise;

  moduleSeedPromise = (async () => {
    if (typeof prisma.$transaction === 'function') {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT 1::int AS locked
             FROM (SELECT pg_advisory_xact_lock($1::bigint)) AS seed_lock`,
          MODULE_SEED_LOCK_KEY,
        );
        await upsertMissingModules(tx);
      });
      return;
    }

    await upsertMissingModules(prisma);
  })();

  try {
    await moduleSeedPromise;
  } finally {
    moduleSeedPromise = null;
  }
}

async function seedGuardrails() {
  await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_guardrails
       (id, enabled, external_ai_enabled, fallback_rate_alert_pct, latency_alert_ms, created_at, updated_at)
     VALUES (1, true, true, 50, 15000, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`
  );
}

async function readModulesFromDb() {
  await seedMissingModules();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT module_key, display_name, description, enabled, provider_override,
            model_override, external_allowed, max_tokens, temperature, settings,
            updated_by, created_at, updated_at
     FROM clinical_ai_modules
     ORDER BY
       CASE WHEN settings->>'status' = 'planned' THEN 2 ELSE 1 END,
       module_key`
  );
  const rowMap = new Map(rows.map((row) => [row.module_key, row]));
  const defaults = CLINICAL_AI_MODULES.map((module) => mergeDefaultWithRow(module, rowMap.get(module.module_key)));
  const extraRows = rows
    .filter((row) => !CLINICAL_AI_MODULES.some((module) => module.module_key === row.module_key))
    .map((row) => normalizeModule(row));
  return [...defaults, ...extraRows];
}

async function readTenantModuleOverrides(tenantId) {
  if (!tenantId) return new Map();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, module_key, enabled, provider_override, model_override,
            external_allowed, max_tokens, temperature, settings, updated_by,
            created_at, updated_at
     FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid`,
    tenantId
  );
  return new Map(rows.map((row) => [row.module_key, row]));
}

async function readGuardrailsFromDb() {
  await seedGuardrails();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, enabled, external_ai_enabled, daily_token_limit,
            daily_cost_limit_minor, request_token_limit, fallback_rate_alert_pct,
            max_fallbacks_per_day, latency_alert_ms, updated_by, created_at, updated_at
     FROM clinical_ai_guardrails
     WHERE id = 1
     LIMIT 1`
  );
  return normalizeGuardrails(rows[0] || DEFAULT_CLINICAL_AI_GUARDRAILS);
}

export async function listClinicalAiModules({ refresh = false, tenantId = null } = {}) {
  if (tenantId) return listClinicalAiTenantModules({ tenantId, refresh });

  if (!refresh && moduleCache && Date.now() - moduleCacheAt < MODULE_CACHE_MS) {
    return moduleCache;
  }

  try {
    moduleCache = await readModulesFromDb();
    moduleCacheAt = Date.now();
    return moduleCache;
  } catch (err) {
    throw schemaUnavailableError(err, 'module_list');
  }
}

export async function listClinicalAiTenantModules({ tenantId = null, refresh = false } = {}) {
  const tid = requireTenantId(tenantId);
  try {
    const [modules, overrides] = await Promise.all([
      listClinicalAiModules({ refresh }),
      readTenantModuleOverrides(tid),
    ]);
    return modules.map((module) => applyTenantOverride(module, overrides.get(module.module_key), tid));
  } catch (err) {
    throw schemaUnavailableError(err, 'tenant_module_list');
  }
}

export async function getClinicalAiGuardrails({ refresh = false } = {}) {
  if (!refresh && guardrailCache && Date.now() - guardrailCacheAt < MODULE_CACHE_MS) {
    return guardrailCache;
  }

  try {
    guardrailCache = await readGuardrailsFromDb();
    guardrailCacheAt = Date.now();
    return guardrailCache;
  } catch (err) {
    throw schemaUnavailableError(err, 'guardrail_read');
  }
}

export async function getClinicalAiModule(moduleKey, { tenantId = null, refresh = false } = {}) {
  const key = sanitizeModuleKey(moduleKey);
  const modules = tenantId
    ? await listClinicalAiTenantModules({ tenantId, refresh })
    : await listClinicalAiModules({ refresh });
  return modules.find((module) => module.module_key === key) || normalizeModule(defaultModuleFor(key));
}

export async function getClinicalAiTenantModule(moduleKey, { tenantId = null, refresh = false } = {}) {
  return getClinicalAiModule(moduleKey, { tenantId: requireTenantId(tenantId), refresh });
}

export async function updateClinicalAiModule(moduleKey, data = {}, updatedBy = null) {
  const key = sanitizeModuleKey(moduleKey);
  if (!key) throw new Error('module_key is required');

  const tid = requireTenantId(data.tenantId || data.tenant_id);
  const current = (await readModulesFromDb().catch((err) => {
    throw schemaUnavailableError(err, 'global_module_read');
  })).find((module) => module.module_key === key) || normalizeModule(defaultModuleFor(key));
  const next = {
    display_name: data.display_name ?? current.display_name,
    description: data.description ?? current.description,
    enabled: typeof data.enabled === 'boolean' ? data.enabled : current.enabled,
    provider_override: data.provider_override === undefined ? current.provider_override : data.provider_override || null,
    model_override: data.model_override === undefined ? current.model_override : data.model_override || null,
    external_allowed: typeof data.external_allowed === 'boolean' ? data.external_allowed : current.external_allowed,
    max_tokens: data.max_tokens === undefined || data.max_tokens === '' ? current.max_tokens : data.max_tokens,
    temperature: data.temperature === undefined || data.temperature === '' ? current.temperature : data.temperature,
    settings: data.settings && typeof data.settings === 'object'
      ? { ...(current.settings || {}), ...data.settings }
      : current.settings || {},
  };
  const normalizedNext = normalizeModule({ ...current, ...next });
  // Patient-surface enablement guard — reject an OFF→ON flip of a patient-facing
  // module before any approval/eval work or DB write (absolute policy denial).
  assertPatientSurfaceEnablementAllowed({ current, next: normalizedNext, data });
  const changedFields = riskyChangedFields(current, normalizedNext);
  const approvalReasons = changeRequiresApproval(current, normalizedNext, changedFields);
  let evalGate = null;

  if (changeRequiresEval(current, normalizedNext, changedFields)) {
    const guardrails = await readGuardrailsFromDb().catch((err) => {
      throw schemaUnavailableError(err, 'module_change_guardrails');
    });
    evalGate = await assertAcceptedEvalGate({
      tenantId: tid,
      moduleKey: key,
      module: normalizedNext,
      guardrails,
    });
  }

  if (approvalReasons.length) {
    const requestedChange = moduleChangePayload({
      scope: 'global',
      tenantId: tid,
      moduleKey: key,
      actorUid: updatedBy,
      changedFields,
      current,
      next: normalizedNext,
      reasons: approvalReasons,
      evalGate,
    });
    const approval = await readApprovedModuleChangeApproval({
      tenantId: tid,
      approvalId: data.approval_id || data.approvalId || null,
      moduleKey: key,
      requestedChangeHash: requestedChange.requested_change_hash,
    });
    if (!approval) {
      return {
        approval_required: true,
        approval: await createPendingModuleChangeApproval({
          tenantId: tid,
          moduleKey: key,
          requestedBy: updatedBy,
          requestedChange,
        }),
        requested_change: requestedChange,
      };
    }
  }

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_modules
         (module_key, display_name, description, enabled, provider_override,
          model_override, external_allowed, max_tokens, temperature, settings,
          updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::uuid, NOW(), NOW())
       ON CONFLICT (module_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         enabled = EXCLUDED.enabled,
         provider_override = EXCLUDED.provider_override,
         model_override = EXCLUDED.model_override,
         external_allowed = EXCLUDED.external_allowed,
         max_tokens = EXCLUDED.max_tokens,
         temperature = EXCLUDED.temperature,
         settings = EXCLUDED.settings,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING module_key, display_name, description, enabled, provider_override,
                 model_override, external_allowed, max_tokens, temperature, settings,
                 updated_by, created_at, updated_at`,
      key,
      next.display_name,
      next.description,
      next.enabled,
      next.provider_override,
      next.model_override,
      next.external_allowed,
      next.max_tokens,
      next.temperature,
      JSON.stringify(next.settings),
      updatedBy || null
    );
  } catch (err) {
    throw schemaUnavailableError(err, 'global_module_update');
  }

  moduleCache = null;
  moduleCacheAt = 0;
  return normalizeModule(rows[0]);
}

export async function updateClinicalAiTenantModule(moduleKey, data = {}, updatedBy = null, { tenantId = null } = {}) {
  const key = sanitizeModuleKey(moduleKey);
  if (!key) throw new Error('module_key is required');
  const tid = requireTenantId(tenantId);
  const globalModules = await readModulesFromDb().catch((err) => {
    throw schemaUnavailableError(err, 'tenant_module_global_read');
  });
  const base = globalModules.find((module) => module.module_key === key) || normalizeModule(defaultModuleFor(key));
  const overrides = await readTenantModuleOverrides(tid).catch((err) => {
    throw schemaUnavailableError(err, 'tenant_module_override_read');
  });
  const current = applyTenantOverride(base, overrides.get(key), tid);
  const currentOverride = current.tenant_overrides || {};
  const next = {
    enabled: data.enabled === undefined
      ? currentOverride.enabled ?? null
      : Boolean(data.enabled),
    provider_override: data.provider_override === undefined
      ? currentOverride.provider_override ?? null
      : data.provider_override || null,
    model_override: data.model_override === undefined
      ? currentOverride.model_override ?? null
      : data.model_override || null,
    external_allowed: data.external_allowed === undefined
      ? currentOverride.external_allowed ?? null
      : (typeof data.external_allowed === 'boolean' ? data.external_allowed : null),
    max_tokens: data.max_tokens === undefined
      ? currentOverride.max_tokens ?? null
      : nullableInt(data.max_tokens),
    temperature: data.temperature === undefined
      ? currentOverride.temperature ?? null
      : (isNil(data.temperature) || data.temperature === '' ? null : Number(data.temperature)),
    settings: data.settings && typeof data.settings === 'object'
      // M14: strip immutable safety-classification keys so a tenant override can
      // never persist a reclassification (e.g. surface 'patient' → 'staff').
      ? { ...(currentOverride.settings || {}), ...stripImmutableModuleSettings(data.settings) }
      : currentOverride.settings || {},
  };
  const nextEffective = normalizeModule({
    ...base,
    enabled: hasOverrideValue(next.enabled) ? next.enabled : base.enabled,
    provider_override: hasOverrideValue(next.provider_override) ? next.provider_override : base.provider_override,
    model_override: hasOverrideValue(next.model_override) ? next.model_override : base.model_override,
    external_allowed: hasOverrideValue(next.external_allowed) ? next.external_allowed : base.external_allowed,
    max_tokens: hasOverrideValue(next.max_tokens) ? next.max_tokens : base.max_tokens,
    temperature: hasOverrideValue(next.temperature) ? next.temperature : base.temperature,
    settings: {
      ...(base.settings || {}),
      // M14: overlay the override settings with immutable safety-classification
      // keys stripped, so surface/risk/patientFacing/decisionSupportOnly always
      // resolve from the code-defined base — even if a stale pre-fix override
      // persisted one. This is what assertPatientSurfaceEnablement reads, so the
      // patient-surface clearance can no longer be evaded by a settings override.
      ...stripImmutableModuleSettings(next.settings || {}),
    },
  });
  // Patient-surface enablement guard — reject an OFF→ON flip of a patient-facing
  // module before any approval/eval work or DB write (absolute policy denial).
  assertPatientSurfaceEnablementAllowed({ current, next: nextEffective, data });
  const changedFields = riskyChangedFields(current, nextEffective);
  const approvalReasons = changeRequiresApproval(current, nextEffective, changedFields);
  let evalGate = null;

  if (changeRequiresEval(current, nextEffective, changedFields)) {
    const guardrails = await readGuardrailsFromDb().catch((err) => {
      throw schemaUnavailableError(err, 'tenant_module_change_guardrails');
    });
    evalGate = await assertAcceptedEvalGate({
      tenantId: tid,
      moduleKey: key,
      module: nextEffective,
      guardrails,
    });
  }

  if (approvalReasons.length) {
    const requestedChange = moduleChangePayload({
      scope: 'tenant',
      tenantId: tid,
      moduleKey: key,
      actorUid: updatedBy,
      changedFields,
      current,
      next: nextEffective,
      reasons: approvalReasons,
      evalGate,
    });
    const approval = await readApprovedModuleChangeApproval({
      tenantId: tid,
      approvalId: data.approval_id || data.approvalId || null,
      moduleKey: key,
      requestedChangeHash: requestedChange.requested_change_hash,
    });
    if (!approval) {
      return {
        approval_required: true,
        approval: await createPendingModuleChangeApproval({
          tenantId: tid,
          moduleKey: key,
          requestedBy: updatedBy,
          requestedChange,
        }),
        requested_change: requestedChange,
      };
    }
  }

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_tenant_modules
         (tenant_id, module_key, enabled, provider_override, model_override,
          external_allowed, max_tokens, temperature, settings, updated_by, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::uuid, NOW(), NOW())
       ON CONFLICT (tenant_id, module_key)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         provider_override = EXCLUDED.provider_override,
         model_override = EXCLUDED.model_override,
         external_allowed = EXCLUDED.external_allowed,
         max_tokens = EXCLUDED.max_tokens,
         temperature = EXCLUDED.temperature,
         settings = EXCLUDED.settings,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      tid,
      key,
      next.enabled,
      next.provider_override,
      next.model_override,
      next.external_allowed,
      next.max_tokens,
      next.temperature,
      JSON.stringify(next.settings),
      updatedBy || null
    );
  } catch (err) {
    throw schemaUnavailableError(err, 'tenant_module_update');
  }

  const result = await getClinicalAiTenantModule(key, { tenantId: tid, refresh: true });

  // C3 (Enablement-plan deep-tier gate): when a deep-tagged module is left in
  // an ENABLED state, surface — non-blocking — whether it will actually produce
  // real AI or silently fall back to a template (no live deep model). This makes
  // the "deep enabled but template-falling-back" hazard observable at enable
  // time instead of only at generation. Best-effort: never block enablement.
  // Dynamic import avoids a load-time cycle (localLlmClient imports from here).
  if (nextEffective.enabled === true) {
    try {
      const { checkDeepModuleReadiness } = await import('./localLlmClient.js');
      const readiness = await checkDeepModuleReadiness(key, { tenantId: tid, smoke: false });
      if (readiness.deepTier && !readiness.ready) {
        result.deep_tier_warning = {
          message: `Deep-tier module enabled but not producing real AI — generations will fall back to a template until the deep model is live: ${readiness.reason}`,
          reason: readiness.reason,
          readiness,
        };
        logger.warn('clinicalAiModuleService: deep-tier module enabled while not live (will template-fallback)', {
          moduleKey: key,
          tenantId: tid,
          reason: readiness.reason,
        });
      }
    } catch (err) {
      logger.warn('clinicalAiModuleService: deep-tier readiness check failed during enable (non-blocking)', {
        moduleKey: key,
        tenantId: tid,
        error: err?.message || String(err),
      });
    }
  }

  return result;
}

export async function deleteClinicalAiTenantModule(moduleKey, { tenantId = null } = {}) {
  const key = sanitizeModuleKey(moduleKey);
  if (!key) throw new Error('module_key is required');
  const tid = requireTenantId(tenantId);
  await prisma.$queryRawUnsafe(
    `DELETE FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid
       AND module_key = $2`,
    tid,
    key
  );
  return getClinicalAiTenantModule(key, { tenantId: tid, refresh: true });
}

export async function updateClinicalAiGuardrails(data = {}, updatedBy = null) {
  const current = await getClinicalAiGuardrails();
  const next = {
    enabled: typeof data.enabled === 'boolean' ? data.enabled : current.enabled,
    external_ai_enabled: typeof data.external_ai_enabled === 'boolean'
      ? data.external_ai_enabled
      : current.external_ai_enabled,
    daily_token_limit: data.daily_token_limit === undefined
      ? current.daily_token_limit
      : nullableInt(data.daily_token_limit),
    daily_cost_limit_minor: data.daily_cost_limit_minor === undefined
      ? current.daily_cost_limit_minor
      : nullableInt(data.daily_cost_limit_minor),
    request_token_limit: data.request_token_limit === undefined
      ? current.request_token_limit
      : nullableInt(data.request_token_limit),
    fallback_rate_alert_pct: data.fallback_rate_alert_pct === undefined
      ? current.fallback_rate_alert_pct
      : clampInt(data.fallback_rate_alert_pct, { min: 0, max: 100, fallback: current.fallback_rate_alert_pct }),
    max_fallbacks_per_day: data.max_fallbacks_per_day === undefined
      ? current.max_fallbacks_per_day
      : nullableInt(data.max_fallbacks_per_day),
    latency_alert_ms: data.latency_alert_ms === undefined
      ? current.latency_alert_ms
      : clampInt(data.latency_alert_ms, { min: 1000, max: 300000, fallback: current.latency_alert_ms }),
  };

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_guardrails
       (id, enabled, external_ai_enabled, daily_token_limit, daily_cost_limit_minor,
        request_token_limit, fallback_rate_alert_pct, max_fallbacks_per_day,
        latency_alert_ms, updated_by, created_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET
       enabled = EXCLUDED.enabled,
       external_ai_enabled = EXCLUDED.external_ai_enabled,
       daily_token_limit = EXCLUDED.daily_token_limit,
       daily_cost_limit_minor = EXCLUDED.daily_cost_limit_minor,
       request_token_limit = EXCLUDED.request_token_limit,
       fallback_rate_alert_pct = EXCLUDED.fallback_rate_alert_pct,
       max_fallbacks_per_day = EXCLUDED.max_fallbacks_per_day,
       latency_alert_ms = EXCLUDED.latency_alert_ms,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING id, enabled, external_ai_enabled, daily_token_limit,
               daily_cost_limit_minor, request_token_limit, fallback_rate_alert_pct,
               max_fallbacks_per_day, latency_alert_ms, updated_by, created_at, updated_at`,
    next.enabled,
    next.external_ai_enabled,
    next.daily_token_limit,
    next.daily_cost_limit_minor,
    next.request_token_limit,
    next.fallback_rate_alert_pct,
    next.max_fallbacks_per_day,
    next.latency_alert_ms,
    updatedBy || null
  );

  guardrailCache = null;
  guardrailCacheAt = 0;
  return normalizeGuardrails(rows[0]);
}

export async function getClinicalAiUsageSummary({ days = 7, tenantId = null } = {}) {
  const windowDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  const tid = requireTenantId(tenantId);
  const [overall, byModule, byProvider, recentFailures, moduleReviews] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 1 ELSE 0 END), 0)::int AS ai_generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallback_count,
         COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(estimated_cost_minor), 0)::int AS estimated_cost_minor,
         COALESCE(SUM(CASE
           WHEN jsonb_typeof(COALESCE(safety_flags, '[]'::jsonb)) = 'array'
           THEN jsonb_array_length(COALESCE(safety_flags, '[]'::jsonb))
           ELSE 0
         END), 0)::int AS safety_flag_count,
         ROUND(AVG(NULLIF(latency_ms, 0)))::int AS avg_latency_ms,
         MAX(created_at) AS last_generation_at
       FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')`,
      tid,
      windowDays
    ),
    prisma.$queryRawUnsafe(
      `SELECT
         COALESCE(module_key, task_type) AS module_key,
         COUNT(*)::int AS generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 1 ELSE 0 END), 0)::int AS ai_generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallback_count,
         COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(estimated_cost_minor), 0)::int AS estimated_cost_minor,
         ROUND(AVG(NULLIF(latency_ms, 0)))::int AS avg_latency_ms,
         MAX(created_at) AS last_generation_at
       FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
       GROUP BY COALESCE(module_key, task_type)
       ORDER BY generation_count DESC, module_key`,
      tid,
      windowDays
    ),
    prisma.$queryRawUnsafe(
      `SELECT
         provider,
         COUNT(*)::int AS generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 1 ELSE 0 END), 0)::int AS ai_generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallback_count,
         COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(estimated_cost_minor), 0)::int AS estimated_cost_minor,
         ROUND(AVG(NULLIF(latency_ms, 0)))::int AS avg_latency_ms,
         MAX(created_at) AS last_generation_at
       FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
       GROUP BY provider
       ORDER BY generation_count DESC, provider`,
      tid,
      windowDays
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, module_key, task_type, provider, model, metadata, created_at
       FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid
         AND used_ai = false
         AND metadata ? 'fallback_reason'
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
       ORDER BY created_at DESC
       LIMIT 10`,
      tid,
      windowDays
    ),
    // Per-module review outcomes — acceptance, rejection, revision counts in
    // the same window so the admin dashboard can render acceptance-rate cards.
    prisma.$queryRawUnsafe(
      `SELECT
         module_key,
         COUNT(*)::int AS review_count,
         COALESCE(SUM(CASE WHEN decision = 'accepted' THEN 1 ELSE 0 END), 0)::int AS accepted_count,
         COALESCE(SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END), 0)::int AS rejected_count,
         COALESCE(SUM(CASE WHEN decision = 'needs_revision' THEN 1 ELSE 0 END), 0)::int AS revision_count,
         COALESCE(SUM(CASE WHEN decision = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending_count
       FROM clinical_ai_reviews
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
       GROUP BY module_key`,
      tid,
      windowDays
    ),
  ]);

  // Fold review metrics into byModule so the admin UI shows one row per module
  // with both generation + acceptance data. Modules with no reviews keep zeros.
  const reviewsByModule = new Map((moduleReviews || []).map((row) => [row.module_key, row]));
  const mergedByModule = (byModule || []).map((row) => {
    const reviews = reviewsByModule.get(row.module_key) || {};
    const reviewCount = Number(reviews.review_count || 0);
    return {
      ...row,
      review_count: reviewCount,
      accepted_count: Number(reviews.accepted_count || 0),
      rejected_count: Number(reviews.rejected_count || 0),
      revision_count: Number(reviews.revision_count || 0),
      pending_count: Number(reviews.pending_count || 0),
      acceptance_rate_pct: reviewCount > 0
        ? Math.round((Number(reviews.accepted_count || 0) / reviewCount) * 100)
        : null,
    };
  });

  return {
    window_days: windowDays,
    overall: overall[0] || {
      generation_count: 0,
      ai_generation_count: 0,
      fallback_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_cost_minor: 0,
      safety_flag_count: 0,
      avg_latency_ms: null,
      last_generation_at: null,
    },
    by_module: mergedByModule,
    by_provider: byProvider,
    recent_failures: recentFailures,
  };
}

export async function getClinicalAiSafetyReviewSummary({ days = 7, tenantId = null } = {}) {
  const windowDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  const tid = requireTenantId(tenantId);

  try {
    const [overallRows, byModule, recentFindings] = await Promise.all([
      prisma.$queryRawUnsafe(
        `WITH review_rows AS (
           SELECT id, generation_id, module_key, status, findings, citation_coverage_pct, created_at
           FROM clinical_ai_safety_reviews
           WHERE tenant_id = $1::uuid
             AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
         ),
         normalized AS (
           SELECT
             *,
             CASE
               WHEN jsonb_typeof(COALESCE(findings, '[]'::jsonb)) = 'array'
               THEN jsonb_array_length(COALESCE(findings, '[]'::jsonb))
               ELSE 0
             END AS finding_count,
             (
               SELECT COUNT(*)::int
               FROM jsonb_array_elements(CASE
                 WHEN jsonb_typeof(COALESCE(findings, '[]'::jsonb)) = 'array'
                 THEN COALESCE(findings, '[]'::jsonb)
                 ELSE '[]'::jsonb
               END) AS finding
               WHERE LOWER(finding->>'severity') IN ('high', 'critical')
             ) AS high_or_critical_finding_count
           FROM review_rows
         )
         SELECT
           COUNT(*)::int AS review_count,
           COALESCE(SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END), 0)::int AS passed_count,
           COALESCE(SUM(CASE WHEN status IN ('needs_review', 'warning') THEN 1 ELSE 0 END), 0)::int AS needs_review_count,
           COALESCE(SUM(CASE WHEN status IN ('blocked', 'failed') THEN 1 ELSE 0 END), 0)::int AS blocked_count,
           ROUND(AVG(citation_coverage_pct))::int AS avg_citation_coverage_pct,
           COALESCE(SUM(CASE WHEN citation_coverage_pct < 100 THEN 1 ELSE 0 END), 0)::int AS low_citation_count,
           COALESCE(SUM(finding_count), 0)::int AS finding_count,
           COALESCE(SUM(high_or_critical_finding_count), 0)::int AS high_or_critical_finding_count,
           MAX(created_at) AS last_review_at
         FROM normalized`,
        tid,
        windowDays
      ),
      prisma.$queryRawUnsafe(
        `WITH normalized AS (
           SELECT
             module_key,
             status,
             citation_coverage_pct,
             created_at,
             (
               SELECT COUNT(*)::int
               FROM jsonb_array_elements(CASE
                 WHEN jsonb_typeof(COALESCE(findings, '[]'::jsonb)) = 'array'
                 THEN COALESCE(findings, '[]'::jsonb)
                 ELSE '[]'::jsonb
               END) AS finding
               WHERE LOWER(finding->>'severity') IN ('high', 'critical')
             ) AS high_or_critical_finding_count
           FROM clinical_ai_safety_reviews
           WHERE tenant_id = $1::uuid
             AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
         )
         SELECT
           module_key,
           COUNT(*)::int AS review_count,
           COALESCE(SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END), 0)::int AS passed_count,
           COALESCE(SUM(CASE WHEN status IN ('needs_review', 'warning') THEN 1 ELSE 0 END), 0)::int AS needs_review_count,
           COALESCE(SUM(CASE WHEN status IN ('blocked', 'failed') THEN 1 ELSE 0 END), 0)::int AS blocked_count,
           ROUND(AVG(citation_coverage_pct))::int AS avg_citation_coverage_pct,
           COALESCE(SUM(high_or_critical_finding_count), 0)::int AS high_or_critical_finding_count,
           MAX(created_at) AS last_review_at
         FROM normalized
         GROUP BY module_key
         ORDER BY blocked_count DESC, high_or_critical_finding_count DESC, needs_review_count DESC, review_count DESC, module_key
         LIMIT 25`,
        tid,
        windowDays
      ),
      prisma.$queryRawUnsafe(
        `SELECT
           sr.id AS review_id,
           sr.generation_id,
           sr.module_key,
           sr.status,
           sr.citation_coverage_pct,
           finding->>'severity' AS severity,
           finding->>'code' AS code,
           finding->>'message' AS message,
           sr.created_at
         FROM clinical_ai_safety_reviews sr
         CROSS JOIN LATERAL jsonb_array_elements(CASE
           WHEN jsonb_typeof(COALESCE(sr.findings, '[]'::jsonb)) = 'array'
           THEN COALESCE(sr.findings, '[]'::jsonb)
           ELSE '[]'::jsonb
         END) AS finding
         WHERE sr.tenant_id = $1::uuid
           AND sr.created_at >= NOW() - ($2::int * INTERVAL '1 day')
         ORDER BY sr.created_at DESC
         LIMIT 25`,
        tid,
        windowDays
      ),
    ]);

    return {
      window_days: windowDays,
      reason: null,
      overall: overallRows[0] || emptySafetyReviewSummary(windowDays).overall,
      by_module: byModule || [],
      recent_findings: recentFindings || [],
    };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return emptySafetyReviewSummary(windowDays, 'safety_review_table_unavailable');
    }
    throw err;
  }
}

function limitState(used, limit) {
  if (!limit || limit <= 0) {
    return {
      used,
      limit: null,
      remaining: null,
      percent_used: null,
      tripped: false,
    };
  }
  const remaining = Math.max(limit - used, 0);
  return {
    used,
    limit,
    remaining,
    percent_used: Math.min(Math.round((used / limit) * 100), 999),
    tripped: used >= limit,
  };
}

export async function getClinicalAiBudgetStatus({ days = 1, guardrails = null, usage = null, tenantId = null } = {}) {
  const activeGuardrails = guardrails || await getClinicalAiGuardrails();
  const activeUsage = usage || await getClinicalAiUsageSummary({ days, tenantId });
  const overall = activeUsage.overall || {};
  const fallbackRatePct = overall.generation_count
    ? Math.round(((overall.fallback_count || 0) / overall.generation_count) * 100)
    : 0;
  const tokenBudget = limitState(overall.total_tokens || 0, activeGuardrails.daily_token_limit);
  const costBudget = limitState(overall.estimated_cost_minor || 0, activeGuardrails.daily_cost_limit_minor);
  const alerts = [];

  if (activeGuardrails.enabled && tokenBudget.tripped) {
    alerts.push({
      severity: 'block',
      code: 'DAILY_TOKEN_LIMIT',
      message: 'Daily clinical AI token budget exhausted',
    });
  }
  if (activeGuardrails.enabled && costBudget.tripped) {
    alerts.push({
      severity: 'block',
      code: 'DAILY_COST_LIMIT',
      message: 'Daily clinical AI estimated cost budget exhausted',
    });
  }
  if (activeGuardrails.enabled && activeGuardrails.max_fallbacks_per_day
      && (overall.fallback_count || 0) >= activeGuardrails.max_fallbacks_per_day) {
    alerts.push({
      severity: 'warn',
      code: 'FALLBACK_COUNT',
      message: 'Clinical AI fallback count exceeded the daily warning threshold',
    });
  }
  if (activeGuardrails.enabled && overall.generation_count >= 5
      && fallbackRatePct >= activeGuardrails.fallback_rate_alert_pct) {
    alerts.push({
      severity: 'warn',
      code: 'FALLBACK_RATE',
      message: 'Clinical AI fallback rate exceeded the warning threshold',
    });
  }
  if (activeGuardrails.enabled && activeGuardrails.latency_alert_ms
      && overall.avg_latency_ms && overall.avg_latency_ms >= activeGuardrails.latency_alert_ms) {
    alerts.push({
      severity: 'warn',
      code: 'LATENCY',
      message: 'Clinical AI average latency exceeded the warning threshold',
    });
  }

  return {
    window_days: Math.min(Math.max(parseInt(days, 10) || 1, 1), 90),
    enabled: activeGuardrails.enabled,
    external_ai_enabled: activeGuardrails.external_ai_enabled,
    token_budget: tokenBudget,
    cost_budget: costBudget,
    request_token_limit: activeGuardrails.request_token_limit,
    fallback_rate_pct: fallbackRatePct,
    alerts,
    blocking_reasons: alerts.filter((alert) => alert.severity === 'block').map((alert) => alert.message),
    tripped: alerts.some((alert) => alert.severity === 'block'),
  };
}

export default {
  CLINICAL_AI_MODULES,
  DEFAULT_CLINICAL_AI_GUARDRAILS,
  deleteClinicalAiTenantModule,
  getClinicalAiBudgetStatus,
  getClinicalAiGuardrails,
  getClinicalAiModule,
  getClinicalAiSafetyReviewSummary,
  getClinicalAiTenantModule,
  getClinicalAiUsageSummary,
  listClinicalAiModules,
  listClinicalAiTenantModules,
  updateClinicalAiGuardrails,
  updateClinicalAiModule,
  updateClinicalAiTenantModule,
};
