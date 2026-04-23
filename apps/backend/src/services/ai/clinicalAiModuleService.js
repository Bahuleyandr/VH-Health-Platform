import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

export const CLINICAL_AI_MODULES = [
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
      outputSchema: { type: 'object', required: ['suggested_codes', 'evidence', 'coder_notes'] },
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
      reviewRoles: ['OT_STAFF', 'ADMIN'],
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
    description: 'Heuristic scheduler: suggests shift assignments from historical demand + preferences. Manager reviews and publishes.',
    enabled: false,
    settings: {
      surface: 'operations',
      risk: 'low',
      status: 'available',
      requiresClinicianSignoff: false,
      reviewRoles: ['ADMIN', 'HR_STAFF', 'DEPARTMENT_HEAD'],
      outputSchema: { type: 'object', required: ['assignments', 'coverage_gaps', 'preference_conflicts'] },
      retentionDays: 365,
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
let moduleCache = null;
let moduleCacheAt = 0;
let guardrailCache = null;
let guardrailCacheAt = 0;

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
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
  return CLINICAL_AI_MODULES.find((module) => module.module_key === key) || {
    module_key: key,
    display_name: key || 'Unknown module',
    description: null,
    enabled: true,
    provider_override: null,
    model_override: null,
    external_allowed: false,
    max_tokens: null,
    temperature: null,
    settings: {},
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

async function seedMissingModules() {
  for (const module of CLINICAL_AI_MODULES) {
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_modules
         (module_key, display_name, description, enabled, settings, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
       ON CONFLICT (module_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         settings = clinical_ai_modules.settings || EXCLUDED.settings,
         updated_at = NOW()`,
      module.module_key,
      module.display_name,
      module.description,
      module.enabled,
      JSON.stringify(module.settings || {})
    );
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
    logger.warn('Clinical AI module table unavailable; using defaults', { error: err.message });
    moduleCache = CLINICAL_AI_MODULES.map((module) => normalizeModule(module));
    moduleCacheAt = Date.now();
    return moduleCache;
  }
}

export async function listClinicalAiTenantModules({ tenantId = null, refresh = false } = {}) {
  const tid = tenantId || DEFAULT_TENANT_ID;
  try {
    const [modules, overrides] = await Promise.all([
      listClinicalAiModules({ refresh }),
      readTenantModuleOverrides(tid),
    ]);
    return modules.map((module) => applyTenantOverride(module, overrides.get(module.module_key), tid));
  } catch (err) {
    logger.warn('Clinical AI tenant module overrides unavailable; using global modules', {
      tenantId: tid,
      error: err.message,
    });
    const modules = await listClinicalAiModules({ refresh });
    return modules.map((module) => applyTenantOverride(module, null, tid));
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
    logger.warn('Clinical AI guardrail table unavailable; using defaults', { error: err.message });
    guardrailCache = normalizeGuardrails(DEFAULT_CLINICAL_AI_GUARDRAILS);
    guardrailCacheAt = Date.now();
    return guardrailCache;
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
  return getClinicalAiModule(moduleKey, { tenantId: tenantId || DEFAULT_TENANT_ID, refresh });
}

export async function updateClinicalAiModule(moduleKey, data = {}, updatedBy = null) {
  const key = sanitizeModuleKey(moduleKey);
  if (!key) throw new Error('module_key is required');

  const current = await getClinicalAiModule(key);
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

  const rows = await prisma.$queryRawUnsafe(
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

  moduleCache = null;
  moduleCacheAt = 0;
  return normalizeModule(rows[0]);
}

export async function updateClinicalAiTenantModule(moduleKey, data = {}, updatedBy = null, { tenantId = null } = {}) {
  const key = sanitizeModuleKey(moduleKey);
  if (!key) throw new Error('module_key is required');
  const tid = tenantId || DEFAULT_TENANT_ID;
  const current = await getClinicalAiTenantModule(key, { tenantId: tid, refresh: true });
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
      ? { ...(currentOverride.settings || {}), ...data.settings }
      : currentOverride.settings || {},
  };

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

  return getClinicalAiTenantModule(key, { tenantId: tid, refresh: true });
}

export async function deleteClinicalAiTenantModule(moduleKey, { tenantId = null } = {}) {
  const key = sanitizeModuleKey(moduleKey);
  if (!key) throw new Error('module_key is required');
  const tid = tenantId || DEFAULT_TENANT_ID;
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
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
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
  const tid = tenantId || DEFAULT_TENANT_ID;

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
