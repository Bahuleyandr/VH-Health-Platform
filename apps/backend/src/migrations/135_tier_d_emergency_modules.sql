-- Migration 135: Tier D emergency / triage AI module configs.
-- Per docs/AI_FEATURE_GAP_BACKLOG.md "Tier D — emergency / triage vertical".
-- Each module wraps the Phase D4 ED entities (emergency_visits,
-- triage_assessments, ambulance_requests, mlc_records). Disabled by default.

BEGIN;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings) VALUES
  ('emergency_triage_form_assistant',
   'Emergency Triage Form Assistant',
   'Drafts the ED triage form (vitals + chief complaint + history of presenting illness + initial impression) from a first-contact transcript or short note.',
   false,
   '{"surface":"emergency","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","EMERGENCY_RESPONDER"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('triage_priority_suggestion',
   'Triage Priority Suggestion',
   'Suggests an ESI (1-5) or Manchester (RED/ORANGE/YELLOW/GREEN/BLUE) priority from the supplied vitals + chief complaint + red-flags. Decision support only — triage nurse signs.',
   false,
   '{"surface":"emergency","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","EMERGENCY_RESPONDER"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object","required":["priority"]},"retentionDays":365}'::jsonb),

  ('ed_red_flag_detection',
   'ED Red Flag Detection',
   'First-contact red-flag screen at ED. Surfaces stroke / sepsis / MI / DKA / anaphylaxis / pediatric red flags from the supplied chief complaint + vitals + age. Distinct from inpatient EWS.',
   false,
   '{"surface":"emergency","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF","EMERGENCY_RESPONDER"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('emergency_visit_summary',
   'Emergency Visit Summary',
   'End-of-visit ED summary draft from the emergency_visits row + linked notes / orders / disposition. For doctor handover or for the patient discharge instructions.',
   false,
   '{"surface":"emergency","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('ambulance_handover_summary',
   'Ambulance Handover Summary',
   'Handover summary for ambulance crew → ED team transitions. Pulls from ambulance_requests + scene observations + en-route interventions.',
   false,
   '{"surface":"emergency","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","AMBULANCE_COORDINATOR","EMERGENCY_RESPONDER"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('stroke_fast_check_assistant',
   'Stroke FAST Check Assistant',
   'Drafts the FAST (Face / Arms / Speech / Time) screen at ED first contact for suspected stroke. Decision support — not a substitute for examination.',
   false,
   '{"surface":"emergency","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('chest_pain_protocol_assistant',
   'Chest Pain Protocol Assistant',
   'Drafts the chest-pain workup checklist (HEART score / TIMI / typical-vs-atypical features / risk stratification) for the on-call clinician.',
   false,
   '{"surface":"emergency","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('trauma_checklist_assistant',
   'Trauma Checklist Assistant',
   'Drafts a trauma resuscitation checklist (primary + secondary survey, ATLS-aligned). Surfaces immediate gaps; never replaces the trauma team leader.',
   false,
   '{"surface":"emergency","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF","EMERGENCY_RESPONDER"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('mlc_documentation_assistant',
   'MLC Documentation Assistant',
   'Drafts the medico-legal case (MLC) documentation pack from the mlc_records row + linked emergency_visit. India-aware: covers IPC / CrPC notation and police-notification fields.',
   false,
   '{"surface":"emergency","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","MEDICAL_RECORDS","ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":2555}'::jsonb)
ON CONFLICT (module_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

COMMIT;
