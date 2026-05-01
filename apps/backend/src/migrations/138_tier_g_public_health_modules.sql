-- Migration 138: Tier G public / population health AI module configs.

BEGIN;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings) VALUES
  ('chronic_disease_registry',
   'Chronic Disease Registry',
   'Population view: patients with a chronic disease (DM / HTN / CKD / cardiac), their last review, last labs, adherence signal. Decision support for the chronic-care team.',
   false,
   '{"surface":"population_health","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CARE_COORDINATOR","ADMIN"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('screening_gap_detection',
   'Screening Gap Detection',
   'Identifies patients due / overdue for preventive screenings (cervical, breast, colon, BP, lipids) per age + sex + risk factors.',
   false,
   '{"surface":"population_health","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CARE_COORDINATOR","ADMIN"],"approvalPolicy":"editorial_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('high_risk_patient_cohorts',
   'High-Risk Patient Cohorts',
   'Builds cohorts at high risk for adverse events (frequent admissions, polypharmacy, multiple chronic conditions). Distinct from trial-matching — this is for chronic-care outreach.',
   false,
   '{"surface":"population_health","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DOCTOR","CARE_COORDINATOR","ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('public_health_report_generator',
   'Public Health Report Generator',
   'Produces aggregate public-health reports (notifiable disease counts, immunisation coverage, ANC visit compliance) from de-identified data only.',
   false,
   '{"surface":"governance","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","DATA_PROTECTION_OFFICER","INTEGRATION_ADMIN"],"approvalPolicy":"admin_review","outputSchema":{"type":"object"},"retentionDays":1095}'::jsonb),

  ('phi_deidentification',
   'PHI De-Identification',
   'General-purpose de-identification of free-text PHI for research / public-health use. Applies HIPAA Safe Harbor 18 identifiers + India-specific (Aadhaar, ABHA) redactions. Sanity-checks output for residual PHI shapes.',
   false,
   '{"surface":"governance","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["DATA_PROTECTION_OFFICER","ADMIN"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":1095}'::jsonb)
ON CONFLICT (module_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

COMMIT;
