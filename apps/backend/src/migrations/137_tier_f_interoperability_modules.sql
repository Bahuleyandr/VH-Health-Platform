-- Migration 137: Tier F interoperability AI module configs.
-- Per docs/AI_FEATURE_GAP_BACKLOG.md "Tier F — interoperability".
-- CDS Hooks adapter shipped earlier via Phase D2; this migration registers
-- the remaining 5 modules. Disabled by default.

BEGIN;

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings) VALUES
  ('fhir_validation_assistant',
   'FHIR Validation Assistant',
   'Validates a supplied FHIR resource (Patient / Encounter / Observation / Condition etc.) for required-element + bound-value-set + slice-friendly issues. Plain-English explanation of any failures.',
   false,
   '{"surface":"interop","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["INTEGRATION_ADMIN","ADMIN"],"approvalPolicy":"admin_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),

  ('abdm_care_context_assistant',
   'ABDM Care Context Assistant',
   'Builds an ABDM CareContext payload for a given encounter / admission. India HIE flow: clinician approves the care-context discoverable list before HIU access.',
   false,
   '{"surface":"interop","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","INTEGRATION_ADMIN","DATA_PROTECTION_OFFICER"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":2555}'::jsonb),

  ('health_record_reconciliation',
   'Health Record Reconciliation',
   'Reconciles two records of the same patient across sources (e.g. external HIE pull vs internal admission). Surfaces conflicts (med list mismatch, allergy diffs, demographic drift) for clinician review.',
   false,
   '{"surface":"interop","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS","INTEGRATION_ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),

  ('document_patient_matching',
   'Document Patient Matching',
   'Suggests matching patient(s) for an externally-sourced document with ambiguous patient identity. Decision support — registrar / MR confirms before linking.',
   false,
   '{"surface":"interop","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["MEDICAL_RECORDS","INTEGRATION_ADMIN","RECEPTIONIST"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object","required":["candidates"]},"retentionDays":180}'::jsonb),

  ('medical_record_bundle_generator',
   'Medical Record Bundle Generator',
   'Generates an export bundle (insurance pack / referral pack / ABDM bundle) from a patient + admission scope. Lists what is included + what is excluded for transparency.',
   false,
   '{"surface":"interop","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS","CLAIMS_MANAGER","INTEGRATION_ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

COMMIT;
