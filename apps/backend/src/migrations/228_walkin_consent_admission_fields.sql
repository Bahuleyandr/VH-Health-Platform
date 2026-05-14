-- 228_walkin_consent_admission_fields.sql
--
-- Stage-5 walk-in-registration + consent cluster. Adds the structured
-- columns six triaged findings need so receptionists/admission clerks
-- stop stuffing payer, scheme, MLC, and consent-method data into
-- free-text notes.
--
-- appointments (walk-in registration) — findings
--   2026-05-10-walk-in-opd-receptionist-no-tpa-fields
--   2026-05-11-dynamic-acute-abdomen-receptionist-6b6a9d03
-- The walk-in payload had no structured payer/category/scheme columns,
-- so a corporate-TPA policy or a govt-scheme-eligible cash patient could
-- only be recorded in appointments.notes. Five additive columns:
--   * payer_type        — funding source descriptor (free-text refinement)
--   * patient_category  — cash | corporate | insurance | tpa | scheme
--   * insurer_name      — insurer / TPA / corporate group name
--   * policy_number     — policy id / employee id / member id
--   * scheme_name       — govt-scheme name (e.g. CMCHIS, Ayushman Bharat)
--
-- patient_consents (consent capture) — findings
--   2026-05-09-inpatient-admission-admission-no-thumbprint-consent-illiterate
--   2026-05-09-inpatient-admission-admission-no-cmchis-flag-no-tamil-consent
-- POST /consent/grant only stored consent_type + free-text notes, so an
-- illiterate patient's thumbprint consent (NABH requires the method +
-- witness on record) and the language the consent form was presented in
-- had nowhere structured to go:
--   * consent_method  — signature | thumbprint | verbal
--   * witness_name    — witness for thumbprint/verbal consent
--   * witness_uid     — witness user uid when the witness is a system user
--   * form_language   — ISO-ish language code the consent form was
--                       presented in (e.g. 'en', 'ta'). The translated
--                       consent-form *text* itself is out of scope here —
--                       [PLACEHOLDER - legal/translation review required].
--
-- admissions (govt-scheme eligibility) — finding
--   2026-05-09-inpatient-admission-admission-no-cmchis-flag-no-tamil-consent
-- Admission had no place to flag CMCHIS / Ayushman Bharat eligibility, so
-- a scheme-eligible rural patient was silently admitted as cash-paying:
--   * govt_scheme         — scheme name (CMCHIS, Ayushman Bharat, ...)
--   * govt_scheme_status  — eligible | pending_verification | enrolled |
--                           not_eligible
--
-- All columns additive / nullable / no default — safe to apply against a
-- live DB. (Finding 2026-05-09-emergency-walk-in-receptionist-no-mlc-flag
-- needs no migration: emergency_visits.is_mlc already exists; the walk-in
-- controller just never wrote to it.)

ALTER TABLE public.appointments
    ADD COLUMN IF NOT EXISTS payer_type varchar(30),
    ADD COLUMN IF NOT EXISTS patient_category varchar(30),
    ADD COLUMN IF NOT EXISTS insurer_name varchar(160),
    ADD COLUMN IF NOT EXISTS policy_number varchar(80),
    ADD COLUMN IF NOT EXISTS scheme_name varchar(120);

ALTER TABLE public.patient_consents
    ADD COLUMN IF NOT EXISTS consent_method varchar(20),
    ADD COLUMN IF NOT EXISTS witness_name varchar(160),
    ADD COLUMN IF NOT EXISTS witness_uid uuid,
    ADD COLUMN IF NOT EXISTS form_language varchar(20);

ALTER TABLE public.admissions
    ADD COLUMN IF NOT EXISTS govt_scheme varchar(60),
    ADD COLUMN IF NOT EXISTS govt_scheme_status varchar(30);

-- Partial index for the admission counsellor worklist — "show me every
-- admission still pending govt-scheme verification".
CREATE INDEX IF NOT EXISTS idx_admissions_govt_scheme_status
    ON public.admissions (govt_scheme_status)
    WHERE govt_scheme_status IS NOT NULL;
