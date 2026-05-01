-- Migration 133: Register Tier A "fastest wins" AI module configs.
--
-- Tier A patient explainers (lab / radiology / generic / prescription /
-- invoice) shipped earlier. This migration registers the 10 remaining
-- Tier A items from docs/AI_FEATURE_GAP_BACKLOG.md so the runtime
-- registry knows about them. Each module is `enabled=false` by default;
-- the admin enables per-tenant when the rollout's ready.
--
-- Settings JSON shape mirrors the existing tier-A patient explainers:
--   surface, risk, status, requiresClinicianSignoff, requiresCitations,
--   reviewRoles, approvalPolicy, outputSchema, retentionDays.

BEGIN;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings) VALUES
  -- Patient-facing
  ('lab_trend_summary',
   'Lab Trend Summary',
   'Patient-facing trend summary for a single analyte over a time window. Plain-language interpretation of whether the value is stable, improving, or worsening relative to prior results + reference range.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object","required":["explanation_summary","trend_direction"]},"retentionDays":365}'::jsonb),

  ('discharge_medication_explanation',
   'Discharge Medication Explanation',
   'Patient-facing explanation of the discharge medication list: what each drug is for, how to take it, side effects to watch for, and which red-flag symptoms require contacting the hospital.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACY_STAFF","NURSING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object","required":["explanation_summary","medications"]},"retentionDays":365}'::jsonb),

  ('patient_faq_assistant',
   'Patient FAQ Assistant',
   'RAG-grounded FAQ answer for patient queries. Retrieves passages from a hospital knowledge base, summarises in plain language, and refuses out-of-scope questions instead of guessing. Decision-support only.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","PATIENT_RELATIONS","ADMIN"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object","required":["explanation_summary","source_citations"]},"retentionDays":180}'::jsonb),

  ('lab_pending_result_reminder',
   'Lab Pending Result Reminder',
   'Patient-facing reminder that a previously-ordered lab is still pending or overdue. Includes test name, expected turnaround, and what to do if the result is delayed beyond the window.',
   false,
   '{"surface":"patient","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","LAB_STAFF","NURSING_STAFF"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),

  -- Staff / operations-facing
  ('front_desk_assistant',
   'Front Desk Assistant',
   'Text variant of the IVR / front-desk script. Answers reception-style questions (visiting hours, department location, how to book, document checklists) using the hospital FAQ KB. Refuses anything clinical.',
   false,
   '{"surface":"reception","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["RECEPTIONIST","ADMIN"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),

  ('audit_log_summary',
   'Audit Log Summary',
   'RAG-style summary of recent audit_log activity over a configurable window: top error patterns, status-code distribution, suspicious access patterns. Read-only; no PHI surfaces in the summary itself.',
   false,
   '{"surface":"governance","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","SUPER_ADMIN","DATA_PROTECTION_OFFICER"],"approvalPolicy":"admin_it_control","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('call_summary',
   'Call Summary',
   'Summary of a doctor-patient or staff-patient call from a transcript. Extracts decisions, follow-up actions, and patient questions. Always cites the transcript section.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","CARE_COORDINATOR"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('handwritten_note_assistant',
   'Handwritten Note Assistant',
   'Structures OCR-extracted handwritten notes into a draft clinical note (subjective / objective / assessment / plan). Flags low-confidence OCR segments for clinician review rather than guessing.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('voice_to_prescription_draft',
   'Voice-to-Prescription Draft',
   'Drafts a prescription from a doctor''s dictated transcript. Always cites the transcript span; never auto-signs; mandatory clinician review before any e-Rx is issued.',
   false,
   '{"surface":"clinical","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACY_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object","required":["medications"]},"retentionDays":365}'::jsonb),

  ('pending_report_tracker',
   'Pending Report Tracker',
   'Staff-facing summary of overdue reports across investigations + radiology. Groups by department, surfaces top blockers, suggests which reports to chase first.',
   false,
   '{"surface":"operations","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["LAB_STAFF","RADIOLOGIST","ADMIN"],"approvalPolicy":"ops_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb)
ON CONFLICT (module_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

COMMIT;
