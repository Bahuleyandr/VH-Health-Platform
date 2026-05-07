-- Migration 162: PM-JAY / Ayushman Bharat workflow (Sprint 16).
--
-- Indian government-scheme pre-auth + claim flow. AB-PMJAY uses fixed-
-- rate Health Benefit Packages (HBP 2.2 — 1929 packages organised in
-- 27 specialty groups), so the model is different from private TPA
-- claims (Sprint 5):
--
--   - Beneficiary verification first (PMJAY ID + biometric / OTP)
--   - Pre-auth references a specific HBP package code (rate + STG)
--   - State-scheme variants (CGHS, ESIC, MJPJAY-MH, BSKY-Odisha,
--     RGJAY, etc.) follow the same shape — `scheme_code` namespacing
--     keeps them all in one table.
--
-- We keep the existing tpa_claims (private insurance) untouched.

BEGIN;

-- ── 1. HBP package master (rate card) ───────────────────────────────
CREATE TABLE IF NOT EXISTS pmjay_packages (
  id              SERIAL PRIMARY KEY,
  scheme_code     VARCHAR(40) NOT NULL DEFAULT 'AB-PMJAY',
                                        -- AB-PMJAY / CGHS / ESIC /
                                        -- MJPJAY / BSKY / RGJAY / etc.
  package_code    VARCHAR(40) NOT NULL,  -- e.g. SS-01-01-001 (HBP 2.2)
  procedure_name  VARCHAR(255) NOT NULL,
  specialty_group VARCHAR(100),          -- 'cardiology', 'general_surgery', …
  package_rate    NUMERIC(12, 2) NOT NULL,
  los_days        INTEGER,               -- pre-defined length of stay
  -- Standard Treatment Guideline narrative — what's bundled.
  inclusions      TEXT,
  exclusions      TEXT,
  -- Whether this package can be combined with others (some are
  -- exclusive — e.g. ICU package can't be combined with general ward).
  bundling_allowed BOOLEAN NOT NULL DEFAULT true,
  active          BOOLEAN NOT NULL DEFAULT true,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, scheme_code, package_code)
);

CREATE INDEX IF NOT EXISTS idx_pmjay_packages_specialty
  ON pmjay_packages(scheme_code, specialty_group, active);

-- Seed a small starter set so a fresh tenant has something to look up.
-- Real deployments overlay the full HBP CSV via a one-time import.
INSERT INTO pmjay_packages
  (scheme_code, package_code, procedure_name, specialty_group, package_rate, los_days, inclusions)
SELECT v.scheme, v.code, v.name, v.spec, v.rate, v.los, v.inc
FROM (VALUES
  ('AB-PMJAY', 'CV-12-01-001', 'CABG (off-pump, 1 graft)',         'cardiology',         90000, 7,  'Surgery, OT, ICU 2d, ward 5d, post-op meds, follow-up day 7+30'),
  ('AB-PMJAY', 'CV-12-01-002', 'CABG (off-pump, 2-3 grafts)',      'cardiology',        110000, 7,  NULL),
  ('AB-PMJAY', 'CV-12-08-001', 'PTCA single-vessel (1 stent)',     'cardiology',         57000, 2,  'Cath lab, single drug-eluting stent, 1 day stay'),
  ('AB-PMJAY', 'GS-15-01-006', 'Laparoscopic appendectomy',        'general_surgery',    14000, 3,  NULL),
  ('AB-PMJAY', 'GS-15-01-008', 'Laparoscopic cholecystectomy',     'general_surgery',    18000, 3,  NULL),
  ('AB-PMJAY', 'OBG-23-04-001', 'Caesarean section',               'obg',                 9000, 5,  NULL),
  ('AB-PMJAY', 'OBG-23-04-002', 'Normal delivery (with episiotomy)', 'obg',               4000, 3,  NULL),
  ('AB-PMJAY', 'ORTHO-21-04-001', 'Total knee replacement (single)', 'orthopedics',      80000, 7,  NULL),
  ('AB-PMJAY', 'ORTHO-21-03-001', 'Hemiarthroplasty (uncemented)',  'orthopedics',       50000, 7,  NULL),
  ('AB-PMJAY', 'PED-24-12-002', 'Neonatal jaundice (phototherapy)', 'paediatrics',        7000, 3,  NULL),
  ('AB-PMJAY', 'MED-19-32-001', 'Diabetic ketoacidosis management', 'general_medicine',  10000, 4,  NULL),
  ('AB-PMJAY', 'OPH-22-02-002', 'Cataract — phacoemulsification',  'ophthalmology',      9500, 1,  'Surgery + IOL + 1 day stay')
) AS v(scheme, code, name, spec, rate, los, inc)
WHERE NOT EXISTS (
  SELECT 1 FROM pmjay_packages
   WHERE scheme_code = v.scheme AND package_code = v.code
     AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
);

-- ── 2. Beneficiary linkage ──────────────────────────────────────────
-- A patient_uid can be linked to one or more scheme beneficiaries
-- (PMJAY ID + state ID). Captured at registration; verified at
-- admission via OTP / biometric.
CREATE TABLE IF NOT EXISTS pmjay_beneficiaries (
  id                SERIAL PRIMARY KEY,
  patient_uid       UUID NOT NULL,
  scheme_code       VARCHAR(40) NOT NULL,
  beneficiary_id    VARCHAR(80) NOT NULL,    -- PMJAY family ID / SECC id
  family_id         VARCHAR(80),
  card_number       VARCHAR(40),             -- e-card / state card #
  policyholder_name VARCHAR(160),            -- household head per RSBY
  age_eligible      BOOLEAN NOT NULL DEFAULT true,
  state_code        VARCHAR(8),              -- KA / MH / TN / DL etc.
  card_url          TEXT,                    -- scanned card image
  -- Verification — two factors per PMJAY rules.
  verified_at       TIMESTAMPTZ,
  verified_by       UUID,
  verification_method VARCHAR(40),           -- otp / aadhaar_biometric /
                                             -- card_match / manual
  -- Cumulative used in the policy year (PMJAY: ₹5L per family per year).
  policy_year       VARCHAR(10),             -- '2026-27'
  cumulative_used   NUMERIC(14, 2) DEFAULT 0,
  notes             TEXT,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, scheme_code, beneficiary_id)
);

CREATE INDEX IF NOT EXISTS idx_pmjay_beneficiaries_patient
  ON pmjay_beneficiaries(patient_uid, scheme_code);

-- ── 3. Pre-auth + claim ────────────────────────────────────────────
-- One row covers both pre-auth and the eventual claim — they share an
-- ID and walk through a status machine.
CREATE TABLE IF NOT EXISTS pmjay_cases (
  id                  SERIAL PRIMARY KEY,
  case_number         VARCHAR(80) UNIQUE NOT NULL,
  beneficiary_id      INTEGER NOT NULL REFERENCES pmjay_beneficiaries(id) ON DELETE RESTRICT,
  patient_uid         UUID NOT NULL,
  admission_id        INTEGER,
  package_id          INTEGER NOT NULL REFERENCES pmjay_packages(id) ON DELETE RESTRICT,
  scheme_reference_id VARCHAR(120),                 -- portal-issued claim id
  -- Clinical
  primary_diagnosis   TEXT NOT NULL,
  icd10_codes         TEXT[],
  treating_doctor_uid UUID,
  treating_doctor_name VARCHAR(160),
  expected_admission_date DATE,
  -- Financial — package_rate is locked at preauth submission so
  -- later rate changes don't affect this case.
  locked_package_rate NUMERIC(12, 2) NOT NULL,
  approved_amount     NUMERIC(12, 2),
  paid_amount         NUMERIC(12, 2),
  paid_at             TIMESTAMPTZ,
  payment_reference   VARCHAR(160),                 -- UTR
  -- Status walk
  status              VARCHAR(30) NOT NULL DEFAULT 'preauth_draft'
    CHECK (status IN (
      'preauth_draft', 'preauth_submitted', 'preauth_approved',
      'preauth_queried', 'preauth_denied',
      'admission_in_progress', 'discharge_pending',
      'claim_submitted', 'claim_queried', 'claim_approved',
      'claim_denied', 'claim_paid', 'claim_closed', 'cancelled'
    )),
  query_text          TEXT,
  denial_reason       TEXT,
  -- Audit
  preauth_submitted_at TIMESTAMPTZ,
  claim_submitted_at  TIMESTAMPTZ,
  notes               TEXT,
  created_by          UUID,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pmjay_cases_beneficiary
  ON pmjay_cases(beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_pmjay_cases_patient
  ON pmjay_cases(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pmjay_cases_status
  ON pmjay_cases(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS pmjay_case_counter (
  tenant_id   UUID NOT NULL,
  fiscal_year VARCHAR(10) NOT NULL,
  next_value  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, fiscal_year)
);

COMMIT;
