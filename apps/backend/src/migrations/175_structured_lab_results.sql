-- 175_structured_lab_results.sql
--
-- Architectural item A5 — structured lab results.
--
-- Existing lab_results is already one-row-per-analyte (each HL7 OBX
-- segment maps to a row). Three gaps remain:
--   1. Multiple analytes from the same panel (CBC has 8) aren't
--      linked — no panel_id / panel_code grouping. Trend + report
--      rendering need this.
--   2. reference_range is a freeform VARCHAR(100) string. Can't
--      compare numerically; can't drive automatic H/L/HH/LL flags.
--   3. No per-sex / per-age-band reference-range lookup. The
--      existing lab_critical_thresholds covers CRITICAL ranges only;
--      lab_reference_ranges covers NORMAL ranges and is the source
--      of truth for abnormal_flag computation.
--
-- This migration:
--   - Adds panel_id (uuid), panel_code, reference_range_low/high to
--     lab_results.
--   - Creates lab_reference_ranges (per-tenant, per-test, per-sex/
--     age-band) with seed rows for common analytes.
--   - Indexes for trending queries (patient + test + date).
--
-- Finding: 2026-05-08-lab-walk-in-lab-tech-no-structured-results.

BEGIN;

-- ── lab_results enrichments ─────────────────────────────────────────
ALTER TABLE lab_results
  -- Groups all rows that came from the same panel entry session.
  -- Set per-panel by recordLabPanel; null for legacy / single-analyte rows.
  ADD COLUMN IF NOT EXISTS panel_id            UUID,
  -- The panel template code (CBC | LIPID | LFT | RFT | THYROID | CARDIAC | ...).
  -- Used for "show all CBCs" + report rendering grouping.
  ADD COLUMN IF NOT EXISTS panel_code          VARCHAR(50),
  -- Numeric reference range. Coexists with the legacy `reference_range`
  -- string field for backward compat.
  ADD COLUMN IF NOT EXISTS reference_range_low  NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS reference_range_high NUMERIC(15, 4);

CREATE INDEX IF NOT EXISTS idx_lab_results_panel
  ON lab_results(panel_id) WHERE panel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_results_patient_test
  ON lab_results(patient_uid, test_code, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_results_panel_code
  ON lab_results(patient_uid, panel_code, performed_at DESC)
  WHERE panel_code IS NOT NULL;

-- ── lab_reference_ranges ────────────────────────────────────────────
-- Tenant-configurable normal ranges, with sex + age applicability.
-- A single test (e.g. Hemoglobin) can have multiple rows: M-adult,
-- F-adult, paediatric, etc. Lookup picks the most specific match.
CREATE TABLE IF NOT EXISTS lab_reference_ranges (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  test_code       VARCHAR(50) NOT NULL,
  loinc_code      VARCHAR(20),
  test_name       VARCHAR(255) NOT NULL,
  unit            VARCHAR(40) NOT NULL,
  -- Numeric bounds. Either may be null for one-sided ranges
  -- (e.g. HDL ">40 mg/dL" → low=40, high=null).
  range_low       NUMERIC(15, 4),
  range_high      NUMERIC(15, 4),
  -- Critical thresholds. lab_critical_thresholds is a parallel table
  -- driving the ALERT pipeline; keep these here so the reference-range
  -- lookup is self-contained and a single query covers both.
  critical_low    NUMERIC(15, 4),
  critical_high   NUMERIC(15, 4),
  -- Applicability filters. NULL = applies to all of that dimension.
  sex             VARCHAR(10),               -- 'M' | 'F' | NULL
  age_band_min_y  SMALLINT,                  -- inclusive lower age bound (years)
  age_band_max_y  SMALLINT,                  -- exclusive upper age bound (years)
  -- Free-text additional notes (e.g. "fasting" preconditions).
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  source          VARCHAR(80),               -- 'manual' | 'lab_master' | 'guideline'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_reference_ranges_lookup
  ON lab_reference_ranges(tenant_id, test_code, is_active);
CREATE INDEX IF NOT EXISTS idx_lab_reference_ranges_loinc
  ON lab_reference_ranges(tenant_id, loinc_code, is_active)
  WHERE loinc_code IS NOT NULL;

-- ── Seed: common analyte reference ranges ──────────────────────────
-- Conservative subset — covers CBC, Lipid, Glucose, LFT, RFT, Thyroid,
-- and Troponin. Adult ranges with sex split where clinically standard.
-- Hospital admin can add / override per tenant via the admin endpoint.
INSERT INTO lab_reference_ranges (tenant_id, test_code, loinc_code, test_name, unit, range_low, range_high, critical_low, critical_high, sex, age_band_min_y, age_band_max_y, source) VALUES
  -- CBC
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HGB', '718-7', 'Hemoglobin', 'g/dL', 13.5, 17.5, 7.0, 20.0, 'M', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HGB', '718-7', 'Hemoglobin', 'g/dL', 12.0, 15.5, 7.0, 20.0, 'F', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HGB', '718-7', 'Hemoglobin', 'g/dL', 11.0, 14.0,  6.0, 18.0, NULL, 0, 18, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'WBC', '6690-2', 'White Blood Cells', 'x10^9/L', 4.0, 11.0, 1.0, 50.0, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'PLT', '777-3', 'Platelets', 'x10^9/L', 150, 450, 50, 1000, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'RBC', '789-8', 'Red Blood Cells', 'x10^12/L', 4.5, 5.9, NULL, NULL, 'M', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'RBC', '789-8', 'Red Blood Cells', 'x10^12/L', 4.0, 5.2, NULL, NULL, 'F', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HCT', '4544-3', 'Hematocrit', '%', 41, 53, NULL, NULL, 'M', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HCT', '4544-3', 'Hematocrit', '%', 36, 46, NULL, NULL, 'F', 18, NULL, 'guideline'),

  -- Lipid panel
  ('00000000-0000-4000-8000-000000000001'::uuid, 'TC',  '2093-3', 'Total Cholesterol', 'mg/dL', NULL, 200, NULL, NULL, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'LDL', '13457-7','LDL Cholesterol',   'mg/dL', NULL, 130, NULL, NULL, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HDL', '2085-9', 'HDL Cholesterol',   'mg/dL', 40,   NULL, NULL, NULL, 'M', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HDL', '2085-9', 'HDL Cholesterol',   'mg/dL', 50,   NULL, NULL, NULL, 'F', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'TRIG','2571-8', 'Triglycerides',     'mg/dL', NULL, 150, NULL, NULL, NULL, 18, NULL, 'guideline'),

  -- Glucose / Diabetic
  ('00000000-0000-4000-8000-000000000001'::uuid, 'FBS',  '1558-6', 'Fasting Blood Sugar',  'mg/dL', 70, 100, 35, 500, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'PPBS', '6749-6', 'Post-prandial Blood Sugar','mg/dL', NULL, 140, 35, 500, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'HBA1C','4548-4', 'HbA1c',                '%',     NULL, 5.7, NULL, NULL, NULL, 18, NULL, 'guideline'),

  -- LFT
  ('00000000-0000-4000-8000-000000000001'::uuid, 'ALT', '1742-6', 'ALT (SGPT)',            'U/L',   7, 56, NULL, NULL, 'M', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'ALT', '1742-6', 'ALT (SGPT)',            'U/L',   7, 45, NULL, NULL, 'F', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'AST', '1920-8', 'AST (SGOT)',            'U/L',  10, 40, NULL, NULL, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'TBIL','1975-2', 'Total Bilirubin',       'mg/dL', 0.3, 1.2, NULL, NULL, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'ALP', '6768-6', 'Alkaline Phosphatase',  'U/L',  44, 147, NULL, NULL, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'ALB', '1751-7', 'Albumin',               'g/dL', 3.5, 5.0, NULL, NULL, NULL, 18, NULL, 'guideline'),

  -- RFT / Electrolytes
  ('00000000-0000-4000-8000-000000000001'::uuid, 'UREA','3094-0', 'Urea',                  'mg/dL',  15, 40, NULL, 200, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'CREA','2160-0', 'Creatinine',            'mg/dL', 0.7, 1.3, NULL, 7.0, 'M', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'CREA','2160-0', 'Creatinine',            'mg/dL', 0.6, 1.1, NULL, 7.0, 'F', 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'NA',  '2951-2', 'Sodium',                'mEq/L', 135, 145, 120, 160, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'K',   '2823-3', 'Potassium',             'mEq/L', 3.5, 5.0, 2.5, 6.5, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'CL',  '2075-0', 'Chloride',              'mEq/L', 96, 106, 80, 120, NULL, 18, NULL, 'guideline'),

  -- Thyroid
  ('00000000-0000-4000-8000-000000000001'::uuid, 'TSH', '3016-3', 'TSH',                   'mIU/L', 0.4, 4.0, NULL, NULL, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'FT4', '3024-7', 'Free T4',               'ng/dL', 0.8, 1.8, NULL, NULL, NULL, 18, NULL, 'guideline'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'FT3', '3051-0', 'Free T3',               'pg/mL', 2.3, 4.2, NULL, NULL, NULL, 18, NULL, 'guideline'),

  -- Cardiac
  ('00000000-0000-4000-8000-000000000001'::uuid, 'TROPI', '10839-9', 'Troponin I',         'ng/mL', NULL, 0.04, NULL, NULL, NULL, 18, NULL, 'guideline')
ON CONFLICT DO NOTHING;

COMMIT;
