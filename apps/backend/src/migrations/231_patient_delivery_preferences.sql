-- Migration 231: Patient delivery-channel preferences + language-tagged
-- discharge summaries.
--
-- Rural / no-smartphone patients (feature phone, illiterate, cash-paying)
-- had zero non-app delivery path for results, bills, and follow-up
-- reminders, and discharge summaries were English-only. Three findings
-- in the patient-portal + delivery-channels cluster converge here:
--   * 2026-05-09-inpatient-admission-patient-no-smartphone-no-alternative-channel
--   * 2026-05-09-lab-walk-in-patient-no-smartphone-no-alternative
--   * 2026-05-09-inpatient-admission-discharge-no-tamil-summary-no-sms-followup
--
-- Adds:
--   1. users.preferred_channel — how the patient wants to be reached
--      (app | sms | print | none). Drives notificationDispatcher channel
--      selection so a feature-phone patient gets SMS/print instead of a
--      silent push that never lands.
--   2. discharge_summaries.summary_language — ISO code the summary body
--      is authored in (tag only; default 'en').
--   3. discharge_summary_sections.body_translations — per-section
--      translated bodies keyed by ISO language code, e.g. {"ta": "..."}.
--      Lets a Tamil discharge summary be produced section-by-section
--      without a schema change per language. Actual translation is a
--      human review step — the service stores a review placeholder, it
--      never machine-translates clinical text.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_channel VARCHAR(10) NOT NULL DEFAULT 'app'
    CHECK (preferred_channel IN ('app', 'sms', 'print', 'none'));

ALTER TABLE discharge_summaries
  ADD COLUMN IF NOT EXISTS summary_language VARCHAR(5) NOT NULL DEFAULT 'en';

ALTER TABLE discharge_summary_sections
  ADD COLUMN IF NOT EXISTS body_translations JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.preferred_channel IS
  'Patient delivery-channel preference: app | sms | print | none. Drives notificationDispatcher channel selection for non-smartphone patients.';
COMMENT ON COLUMN discharge_summaries.summary_language IS
  'ISO language code the summary body is authored in (tag only; default en).';
COMMENT ON COLUMN discharge_summary_sections.body_translations IS
  'Per-section translated bodies keyed by ISO language code, e.g. {"ta": "..."}. Empty {} = no translation yet.';

COMMIT;
