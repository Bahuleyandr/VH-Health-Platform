-- Migration 134: Tier C clinical-assistant module configs.
-- Per docs/AI_FEATURE_GAP_BACKLOG.md "Tier C — clinical assistants the
-- catalogue flags as P0/P1". Each module is enabled=false by default;
-- the admin enables per-tenant when its rollout is ready.

BEGIN;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings) VALUES
  ('medical_certificate_draft',
   'Medical Certificate Draft',
   'Drafts a fitness / sickness / vaccination / disability medical certificate from the encounter context. Doctor reviews + signs before issue.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":730}'::jsonb),

  ('clinic_letter_draft',
   'Clinic Letter Draft',
   'Drafts a referring-physician letter or follow-up clinic letter from a signed clinical note. Doctor reviews + signs before send.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","MEDICAL_RECORDS"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('clinical_note_cleanup',
   'Clinical Note Cleanup',
   'Re-structures a free-text clinical note into a clean SOAP / problem-oriented format without changing meaning. Flags ambiguous spans.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","MEDICAL_RECORDS"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('missing_questions_assistant',
   'Missing-Questions Assistant',
   'Reviews a partial history and suggests follow-up questions a clinician might want to ask given the chief complaint, age, comorbidities. Suggests only — never auto-asks.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","JUNIOR_DOCTOR","RESIDENT"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('missing_examination_assistant',
   'Missing-Examination Assistant',
   'Suggests examination steps not yet documented for the working diagnosis. Suggests only — clinician decides.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","JUNIOR_DOCTOR","RESIDENT"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('missing_tests_assistant',
   'Missing-Tests Assistant',
   'Surfaces investigations that are recommended for the working diagnosis but absent from the encounter''s order list. Decision support only.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","JUNIOR_DOCTOR","LAB_STAFF","RADIOLOGIST"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('order_set_suggestion',
   'Order-Set Suggestion',
   'Suggests an order-set bundle (sepsis, AMI, stroke, DKA, etc.) given the encounter context. Bundle is a draft; clinician picks per-line.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","JUNIOR_DOCTOR"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('renal_dose_check',
   'Renal Dose Check',
   'Standalone renal-function-aware dose review. Compares prescribed dose against the patient''s eGFR / creatinine + drug renal-adjustment guidance.',
   false,
   '{"surface":"pharmacy","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","PHARMACY_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('liver_dose_check',
   'Liver Dose Check',
   'Standalone hepatic-function-aware dose review. Compares prescribed dose against the patient''s LFTs + drug hepatic-adjustment guidance.',
   false,
   '{"surface":"pharmacy","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","PHARMACY_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('pregnancy_lactation_warning',
   'Pregnancy / Lactation Warning',
   'Standalone pregnancy- or lactation-status-aware drug safety review. Flags category C/D/X drugs and surfaces risk classification.',
   false,
   '{"surface":"pharmacy","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","PHARMACY_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('adverse_drug_event_detector',
   'Adverse Drug Event Detector',
   'Reviews a recent vital / lab / symptom signal and decides whether it is a likely adverse drug event for any of the patient''s active medications. Decision support only.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF","PHARMACY_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('fall_risk_prediction',
   'Fall Risk Prediction',
   'AI scoring layer on top of the F2 fall_risk_assessments entity. Reads the most recent assessment + medications + mobility + history and predicts fall risk for the next 24-72h.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('pressure_ulcer_risk_prediction',
   'Pressure Ulcer Risk Prediction',
   'Predicts pressure-ulcer risk over the next admission day using mobility, nutrition, moisture, friction-shear inputs. Supports the nursing assessment, never replaces it.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('aki_risk_alert',
   'AKI Risk Alert',
   'Flags rising creatinine / falling urine output / nephrotoxic drug stack as an Acute Kidney Injury risk. Emits a draft alert; clinician acknowledges + acts.',
   false,
   '{"surface":"clinical","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('intake_output_summary',
   'Intake / Output Summary',
   'Daily I/O summary across vitals + IV fluids + drains + urine output for an admitted patient. Highlights net balance + trends.',
   false,
   '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('icu_round_summary',
   'ICU Round Summary',
   'Per-admitted-patient ICU round summary: top-line problems, overnight events, today''s plan, pending items. Decision support for the rounding team.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","CONSULTANT","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb)
ON CONFLICT (module_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

COMMIT;
