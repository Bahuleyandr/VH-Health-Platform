-- 438_engagement_patient_consent_types.sql
-- NL9-P1 keeps patient_consents as the only patient consent source of truth.
-- This migration adds the active lookup path for the narrow engagement consent
-- types used by campaigns; no parallel engagement consent store is introduced.

CREATE INDEX IF NOT EXISTS idx_patient_consents_engagement_active
  ON patient_consents (tenant_id, patient_uid, consent_type, granted_at DESC)
  WHERE consent_type IN (
    'marketing_whatsapp',
    'care_reminder_whatsapp',
    'rpm_monitoring',
    'nps_survey',
    'teleconsult_followup'
  )
    AND granted = TRUE
    AND revoked_at IS NULL;

COMMENT ON INDEX idx_patient_consents_engagement_active IS
  'NL9-P1 active consent lookup for engagement campaigns; patient_consents remains the consent source of truth.';

COMMENT ON COLUMN patient_consents.consent_type IS
  'Includes narrow NL9 engagement consent types: marketing_whatsapp, care_reminder_whatsapp, rpm_monitoring, nps_survey, teleconsult_followup.';
