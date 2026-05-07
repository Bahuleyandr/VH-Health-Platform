-- Migration 151: Lab results + critical alerts + pathologist worklist (Sprint 3).
--
-- HL7 ORU^R01 messages from lab analyzers (Beckman, Abbott, Sysmex, Roche)
-- need a destination table. Existing schema covers booking
-- (investigation_bookings) and AI autoverification
-- (clinical_ai_lab_autoverifications) but doesn't actually persist the
-- per-analyte results. This migration adds:
--
--   1) lab_results — one row per OBX analyte (CBC = ~20 rows per ORU).
--   2) lab_critical_thresholds — per-LOINC abnormal/critical limits with
--      tenant override capability. Seeded with a small starter set of
--      universally-recognised critical values (potassium, sodium,
--      glucose, troponin, hemoglobin, platelets).
--   3) lab_critical_alerts — append-only log of every critical-flagged
--      result that fired an alert, with acknowledgement workflow.
--   4) lab_pathologist_signoffs — pathologist verification + comments
--      on a result set. Required for outpatient release of complex
--      panels under NABH 5.6.
--
-- Idempotent CREATEs.

BEGIN;

-- ── Lab results (one row per analyte / OBX segment) ───────────────────
CREATE TABLE IF NOT EXISTS lab_results (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  -- Source linkage. booking_id ties to investigation_bookings; can be
  -- null for ad-hoc results entered manually before a booking exists.
  booking_id            INTEGER,
  patient_uid           UUID NOT NULL,
  patient_name          VARCHAR(255),
  -- HL7 OBR/OBX identification
  hl7_message_id        VARCHAR(100),                  -- MSH-10 control id
  hl7_segment_index     INTEGER,                       -- OBX-1 set id
  -- Analyte identity (LOINC preferred; local code as fallback)
  loinc_code            VARCHAR(20),
  test_code             VARCHAR(50) NOT NULL,
  test_name             VARCHAR(255) NOT NULL,
  -- Value + units
  value_text            VARCHAR(255),                  -- raw OBX-5
  value_numeric         NUMERIC(15, 4),                -- parsed when numeric
  unit                  VARCHAR(40),
  reference_range       VARCHAR(100),                  -- "70 - 110" etc.
  -- Status + interpretation
  abnormal_flag         VARCHAR(10),                   -- L / H / LL / HH / N / A / AA from OBX-8
  status                VARCHAR(20) NOT NULL DEFAULT 'preliminary',
                                                       -- preliminary / final / corrected / cancelled
  is_critical           BOOLEAN NOT NULL DEFAULT false,
  -- Provenance
  performed_by_lab      VARCHAR(255),                  -- analyzer or external lab
  performed_at          TIMESTAMPTZ,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Pathologist sign-off (lazy, denormalised from lab_pathologist_signoffs)
  signed_off_at         TIMESTAMPTZ,
  signed_off_by         UUID,
  comments              TEXT,
  raw_obx               TEXT,                          -- the raw OBX line for audit
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_results_patient ON lab_results(patient_uid, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_results_booking ON lab_results(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_results_loinc ON lab_results(loinc_code) WHERE loinc_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_results_critical ON lab_results(tenant_id, is_critical, received_at DESC) WHERE is_critical = true;
CREATE INDEX IF NOT EXISTS idx_lab_results_pending_signoff ON lab_results(tenant_id, status, received_at) WHERE signed_off_at IS NULL AND status = 'preliminary';

-- ── Critical thresholds ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab_critical_thresholds (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  loinc_code            VARCHAR(20),
  test_code             VARCHAR(50),                   -- when LOINC unknown
  test_name             VARCHAR(255) NOT NULL,
  unit                  VARCHAR(40),
  -- Bounds — any value < critical_low or > critical_high triggers alert.
  -- Use NULL to indicate "unbounded on this side".
  critical_low          NUMERIC(15, 4),
  critical_high         NUMERIC(15, 4),
  applies_to            VARCHAR(20) DEFAULT 'all',     -- all / adult / paediatric / neonatal
  is_active             BOOLEAN NOT NULL DEFAULT true,
  source                VARCHAR(80) DEFAULT 'manual',  -- manual / nabh / cap / hospital
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_critical_thresh_loinc
  ON lab_critical_thresholds(loinc_code) WHERE loinc_code IS NOT NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_critical_thresh_test_code
  ON lab_critical_thresholds(test_code) WHERE is_active = true;

-- Seed universally-recognised critical values. Hospital pathologist
-- can edit / extend / disable these. Sources: NABH 5.6 + CAP CAP-2009.
INSERT INTO lab_critical_thresholds (loinc_code, test_code, test_name, unit, critical_low, critical_high, source, notes)
SELECT * FROM (VALUES
  ('2823-3'::VARCHAR(20),  'K'::VARCHAR(50),    'Potassium'::VARCHAR(255),       'mmol/L'::VARCHAR(40),  2.8::NUMERIC, 6.2::NUMERIC, 'nabh'::VARCHAR(80),  'Hyperkalaemia >6.2 risks arrhythmia'::TEXT),
  ('2951-2',               'NA',                'Sodium',                        'mmol/L',               120::NUMERIC, 160::NUMERIC, 'nabh',               'Severe hypo/hypernatremia'),
  ('2345-7',               'GLU',               'Glucose',                       'mg/dL',                50::NUMERIC,  500::NUMERIC, 'nabh',               'Hypo/hyperglycaemia critical'),
  ('6598-7',               'TROP',              'Troponin I',                    'ng/mL',                NULL::NUMERIC, 0.04::NUMERIC, 'cap',              'Above 0.04 ng/mL suggests AMI'),
  ('718-7',                'HGB',               'Hemoglobin',                    'g/dL',                 6.5::NUMERIC, 20::NUMERIC,  'nabh',               'Severe anaemia / polycythaemia'),
  ('777-3',                'PLT',               'Platelet count',                '10^3/uL',              30::NUMERIC,  1000::NUMERIC,'nabh',               'Severe thrombocytopenia / thrombocytosis'),
  ('6690-2',               'WBC',               'White blood cell count',        '10^3/uL',              2::NUMERIC,   30::NUMERIC,  'nabh',               'Severe leukopenia / leukocytosis'),
  ('1751-7',               'ALB',               'Albumin',                       'g/dL',                 1.5::NUMERIC, NULL::NUMERIC,'cap',                'Severe hypoalbuminaemia'),
  ('33914-3',              'EGFR',              'Estimated GFR',                 'mL/min/1.73m2',        15::NUMERIC,  NULL::NUMERIC,'cap',                'Stage 5 CKD threshold'),
  ('1920-8',               'AST',               'Aspartate aminotransferase',    'U/L',                  NULL::NUMERIC, 1000::NUMERIC,'cap',               'Acute hepatic injury'),
  ('1742-6',               'ALT',               'Alanine aminotransferase',      'U/L',                  NULL::NUMERIC, 1000::NUMERIC,'cap',               'Acute hepatic injury'),
  ('14979-9',              'INR',               'INR',                           'ratio',                NULL::NUMERIC, 5::NUMERIC,   'cap',                'Severe coagulopathy / bleed risk')
) AS seed(loinc_code, test_code, test_name, unit, critical_low, critical_high, source, notes)
WHERE NOT EXISTS (SELECT 1 FROM lab_critical_thresholds);

-- ── Critical alerts (append-only audit log) ──────────────────────────
CREATE TABLE IF NOT EXISTS lab_critical_alerts (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  result_id             INTEGER NOT NULL REFERENCES lab_results(id) ON DELETE CASCADE,
  patient_uid           UUID NOT NULL,
  test_name             VARCHAR(255) NOT NULL,
  value_text            VARCHAR(255),
  value_numeric         NUMERIC(15, 4),
  unit                  VARCHAR(40),
  threshold_breached    VARCHAR(20),                   -- 'low' / 'high'
  threshold_value       NUMERIC(15, 4),
  fired_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Acknowledgement workflow: a clinician (usually the ordering doctor
  -- or the on-call) must ACK every critical alert. NABH 5.6 expects an
  -- audit trail of read-back communication.
  acknowledged_at       TIMESTAMPTZ,
  acknowledged_by       UUID,
  acknowledged_by_name  VARCHAR(255),
  read_back_method      VARCHAR(40),                   -- phone / sms / in-person / app
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_critical_alerts_tenant_pending
  ON lab_critical_alerts(tenant_id, fired_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_critical_alerts_patient
  ON lab_critical_alerts(patient_uid, fired_at DESC);

-- ── Pathologist sign-offs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab_pathologist_signoffs (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  booking_id            INTEGER,                       -- batch sign-off for a panel/booking
  patient_uid           UUID NOT NULL,
  result_ids            INTEGER[] NOT NULL,            -- which lab_results rows this signs off
  signed_off_by         UUID NOT NULL,
  signed_off_by_name    VARCHAR(255),
  signed_off_by_reg     VARCHAR(80),                   -- MCI / state council number
  decision              VARCHAR(20) NOT NULL DEFAULT 'verified',  -- verified / rejected / corrected
  comments              TEXT,
  signed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_path_signoff_booking ON lab_pathologist_signoffs(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_path_signoff_patient ON lab_pathologist_signoffs(patient_uid, signed_at DESC);

COMMIT;
