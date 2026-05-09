-- 182_emergency_consent_bypass.sql
--
-- B-4 — emergency consent bypass tracking.
--
-- Background. The admission consent gate
-- (services/emr/admissionService.js#admitPatient) requires an active
-- 'treatment' consent in patient_consents before any admission can
-- be created. That's correct for elective and routine admissions.
-- For an unconscious / hemodynamically-unstable / clinically-emergent
-- patient, holding the bed for written consent is at best wasteful
-- and at worst negligent — implied consent doctrine + Indian medical
-- ethics permit life-saving care without prior written consent.
--
-- Findings:
--   - 2026-05-08-emergency-walk-in-admission-emergency-blocked-by-consent
--   - 2026-05-08-inpatient-admission-doctor-emergency-admit-blocked-by-treatment-consent
--
-- This migration adds three columns on `admissions` so the bypass is
-- auditable, attributed, and trackable through to post-stabilisation
-- consent capture:
--   - emergency_consent_bypass_at
--       Stamped by admitPatient at the moment the bypass fired. NULL
--       on every non-bypass admission.
--   - emergency_consent_bypass_by
--       The clinician who authorised the bypass — typically the
--       admitting_doctor on an emergency admission, but kept as a
--       distinct column so audit reports don't have to infer.
--   - emergency_consent_bypass_reason
--       Free-text + structured "unconscious", "minor without guardian",
--       "life-threatening", etc. The walk-in doctor types this in.
--
-- Plus a partial index for the post-stabilisation consent-capture
-- worklist ("admissions still missing written consent").

BEGIN;

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS emergency_consent_bypass_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emergency_consent_bypass_by     UUID,
  ADD COLUMN IF NOT EXISTS emergency_consent_bypass_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_admissions_consent_bypass_pending
  ON admissions(emergency_consent_bypass_at)
  WHERE emergency_consent_bypass_at IS NOT NULL
    AND status IN ('admitted', 'transferred');

COMMIT;
