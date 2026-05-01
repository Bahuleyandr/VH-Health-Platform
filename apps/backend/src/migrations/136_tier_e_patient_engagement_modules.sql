-- Migration 136: Tier E patient-engagement AI module configs.
-- Per docs/AI_FEATURE_GAP_BACKLOG.md "Tier E — patient-facing engagement
-- (mostly missing)". Disabled by default; admin enables per-tenant.

BEGIN;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings) VALUES
  ('symptom_red_flag_checker',
   'Symptom Red-Flag Checker',
   'Live patient-facing symptom triage. Surfaces red-flag patterns (stroke, MI, sepsis, anaphylaxis, pediatric / pregnancy emergencies) and tells the patient when to seek emergency care vs same-day clinic vs self-monitor.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('chronic_disease_coach',
   'Chronic Disease Coach',
   'Per-condition coaching draft (DM / HTN / CKD / cardiac / obstetric). Reads recent labs + medications + adherence history and drafts a single-week guidance message.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","CARE_COORDINATOR"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('post_discharge_checkin_bot',
   'Post-Discharge Check-In Bot',
   'Drafts a structured check-in (day 1 / day 3 / day 7 / day 30) for a post-discharge patient. Asks about pain, medications, red-flag symptoms; routes red flags to the clinician.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","CARE_COORDINATOR"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('post_surgery_monitoring_bot',
   'Post-Surgery Monitoring Bot',
   'Surgical-recovery check-in draft. Pulls procedure type + post-op day and prompts the patient on wound care, mobility, red-flag complications, follow-up.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('home_vitals_insights',
   'Home Vitals Insights',
   'Patient-facing summary of self-reported home vitals (BP, glucose, weight, SpO2). Highlights trends + when to seek help. Decision support only.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","CARE_COORDINATOR"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('diet_advice_draft',
   'Diet Advice Draft',
   'Patient-facing diet guidance for the prevailing condition (DM / HTN / CKD / pregnancy / weight). Dietitian reviews + signs.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","DIETITIAN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('exercise_advice_draft',
   'Exercise Advice Draft',
   'Patient-facing exercise / activity guidance for the prevailing condition or post-procedure state. Physiotherapist reviews + signs.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHYSIOTHERAPIST"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('mental_health_screening_bot',
   'Mental Health Screening Bot',
   'Drafts a PHQ-9 / GAD-7 / EPDS screening exchange and interprets the patient response. Flags positive screens for clinician follow-up.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","COUNSELLOR"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('medication_reminder_generator',
   'Medication Reminder Generator',
   'Generates a per-medication daily reminder schedule from the active prescription list. Can include red-flag symptoms to watch for per drug.',
   false,
   '{"surface":"patient","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACY_STAFF","NURSING_STAFF"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('follow_up_reminder_generator',
   'Follow-Up Reminder Generator',
   'Generates a follow-up appointment / lab / imaging reminder schedule from the discharge plan. Tracks calendar relative to admission_date / discharge_date.',
   false,
   '{"surface":"patient","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CARE_COORDINATOR"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('pre_visit_form_assistant',
   'Pre-Visit Form Assistant',
   'Helps a patient prepare for an upcoming appointment: history-taking prompts, document checklist, list of medications to bring, questions to ask the doctor.',
   false,
   '{"surface":"patient","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CARE_COORDINATOR","RECEPTIONIST"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),

  ('preventive_health_recommender',
   'Preventive Health Recommender',
   'Recommends preventive screenings (cervical, breast, colon, BP, lipids) based on age + sex + family history + comorbidities. Decision support only.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CARE_COORDINATOR"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('family_health_risk_summary',
   'Family Health Risk Summary',
   'Distills family medical history into a per-condition risk profile + suggested screening cadence for the patient. Decision support — clinician validates.',
   false,
   '{"surface":"patient","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CARE_COORDINATOR"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

COMMIT;
