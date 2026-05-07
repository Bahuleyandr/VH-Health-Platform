-- Migration 165: ICU flowsheet + RASS/CAM-ICU + ABCDEF daily bundles
-- (Sprint 19).
--
-- Closes the biggest remaining clinical-depth gap. ICU work has three
-- parts none of which existed yet:
--
-- 1. ICU admission header — when a patient enters the unit, why,
--    severity score (APACHE-II / SOFA), expected length-of-stay.
-- 2. Hourly flowsheet — vitals + ventilator + drips + I/O + neuro
--    every hour. Same shape as the anesthesia chart in 163 but at
--    a coarser cadence and with neuro fields the OT chart doesn't
--    need.
-- 3. ICU-specific assessments — RASS (Richmond Agitation-Sedation
--    Scale) and CAM-ICU (Confusion Assessment Method for ICU) drive
--    sedation titration and delirium screening, both required for the
--    ABCDEF bundle.
-- 4. ABCDEF daily bundle compliance — the SCCM-recommended ICU
--    Liberation bundle. Track adherence per-patient per-day to
--    surface gaps. (Awakening, Breathing trial, Choice of analgesia,
--    Delirium assess+manage, Early mobility, Family engagement.)

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. ICU ADMISSION HEADER
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS icu_admissions (
  id                    SERIAL PRIMARY KEY,
  patient_uid           UUID NOT NULL,
  admission_id          INTEGER,                    -- ward-level admission FK
  unit_code             VARCHAR(20) NOT NULL,       -- 'MICU' / 'SICU' / 'CCU' / 'PICU' / 'NICU'
  bed_no                VARCHAR(20),
  admitted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admitting_doctor_uid  UUID,
  admitting_doctor_name VARCHAR(160),
  primary_diagnosis     TEXT,
  reason_for_icu        TEXT,                       -- "septic shock req noradr", "post-op CABG"

  -- Severity scores at admission. Frozen after 24h (APACHE-II spec).
  apache_ii_score       INTEGER,
  apache_ii_at          TIMESTAMPTZ,
  sofa_score            INTEGER,                    -- updated daily; this column = admission SOFA
  predicted_mortality_pct NUMERIC(4, 1),

  -- Expected discharge target — quality measure: actual vs expected LOS.
  expected_los_days     INTEGER,

  -- Code status — DNR/DNI/full-code. Surfaces on flowsheet so any new
  -- intensivist sees it immediately.
  code_status           VARCHAR(20) DEFAULT 'full_code'
    CHECK (code_status IN ('full_code', 'dni', 'dnr', 'dnr_dni', 'comfort_only')),
  code_status_set_at    TIMESTAMPTZ,
  code_status_set_by    UUID,

  status                VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'discharged', 'transferred', 'expired')),
  discharged_at         TIMESTAMPTZ,
  discharge_disposition VARCHAR(40),                -- 'ward' / 'step_down' / 'home' / 'expired' / 'transferred_out'
  outcome_notes         TEXT,

  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icu_adm_active
  ON icu_admissions(tenant_id, unit_code, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_icu_adm_patient
  ON icu_admissions(patient_uid, admitted_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- 2. HOURLY FLOWSHEET — wide table, named columns (one row = one hour)
-- ════════════════════════════════════════════════════════════════════
--
-- Why named columns and not JSONB: nurses query historical trends ("show
-- me MAP for last 12 hours") and the trending widget needs typed numbers.
-- JSONB-extracted INTEGERs are 5-10x slower at scale.

CREATE TABLE IF NOT EXISTS icu_flowsheet_entries (
  id                  SERIAL PRIMARY KEY,
  icu_admission_id    INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Vitals
  hr                  INTEGER,
  sbp                 INTEGER,
  dbp                 INTEGER,
  map                 INTEGER,
  cvp                 INTEGER,                       -- central venous pressure (cmH2O)
  spo2                INTEGER,
  rr                  INTEGER,
  temp_c              NUMERIC(4, 1),
  -- Capillary refill, perfusion
  cap_refill_sec      NUMERIC(3, 1),

  -- Neuro
  gcs_eye             INTEGER,                       -- 1-4
  gcs_verbal          INTEGER,                       -- 1-5 (or 1 if intubated)
  gcs_motor           INTEGER,                       -- 1-6
  gcs_total           INTEGER,                       -- materialised; nurses ask "what's the GCS?"
  pupils_left_size_mm NUMERIC(3, 1),
  pupils_right_size_mm NUMERIC(3, 1),
  pupils_reactive     VARCHAR(20),                   -- 'both_brisk' / 'left_sluggish' / etc.

  -- Ventilator
  vent_mode           VARCHAR(20),                   -- 'cmv' / 'simv' / 'psv' / 'cpap' / 'spontaneous' / 'off'
  fio2_pct            INTEGER,
  peep_cmh2o          NUMERIC(4, 1),
  tidal_volume_ml     INTEGER,
  resp_rate_set       INTEGER,
  airway_pressure_peak INTEGER,
  airway_pressure_plateau INTEGER,
  pf_ratio            INTEGER,                       -- PaO2/FiO2 — ARDS severity

  -- Drips (active continuous infusions, mcg/kg/min where applicable)
  noradrenaline_mcg_kg_min NUMERIC(6, 3),
  adrenaline_mcg_kg_min    NUMERIC(6, 3),
  vasopressin_units_hr     NUMERIC(6, 3),
  dobutamine_mcg_kg_min    NUMERIC(6, 3),
  propofol_mcg_kg_min      NUMERIC(6, 3),
  midazolam_mg_hr          NUMERIC(6, 3),
  fentanyl_mcg_hr          NUMERIC(6, 3),
  insulin_units_hr         NUMERIC(6, 3),
  -- Other infusions: free-form JSONB to avoid column explosion
  other_drips         JSONB DEFAULT '[]'::jsonb,    -- [{name, rate, unit}]

  -- Intake / output (this hour only — running total computed by view)
  iv_fluids_ml        INTEGER,
  oral_intake_ml      INTEGER,
  blood_products_ml   INTEGER,
  urine_output_ml     INTEGER,
  drain_output_ml     INTEGER,
  ng_aspirate_ml      INTEGER,
  stool_count         INTEGER,
  -- Net for this hour (intake − output) — materialised for fast running totals
  net_balance_ml      INTEGER,

  -- Vent settings change / event note
  event_note          TEXT,

  recorded_by         UUID,
  recorded_by_name    VARCHAR(160),
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icu_flow_admission
  ON icu_flowsheet_entries(icu_admission_id, recorded_at);

-- ════════════════════════════════════════════════════════════════════
-- 3. ICU-SPECIFIC ASSESSMENTS — RASS + CAM-ICU
-- ════════════════════════════════════════════════════════════════════
--
-- RASS scale −5 (unarousable) → +4 (combative), 0 = alert/calm.
-- CAM-ICU = positive only when:
--   feature 1 (acute change in mental status) AND
--   feature 2 (inattention) AND
--   (feature 3 (altered LOC) OR feature 4 (disorganized thinking)).
-- Most useful as a 4-feature breakdown so we can audit consistency.

CREATE TABLE IF NOT EXISTS icu_assessments (
  id                  SERIAL PRIMARY KEY,
  icu_admission_id    INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  assessment_kind     VARCHAR(20) NOT NULL CHECK (assessment_kind IN ('rass', 'cam_icu', 'sofa', 'cpot')),

  -- RASS
  rass_score          INTEGER,                       -- −5..+4
  rass_target         INTEGER,                       -- physician-set target band
  -- CAM-ICU (4 features, all booleans)
  cam_feature_1       BOOLEAN,                       -- acute mental status change OR fluctuating
  cam_feature_2       BOOLEAN,                       -- inattention
  cam_feature_3       BOOLEAN,                       -- altered level of consciousness (RASS != 0)
  cam_feature_4       BOOLEAN,                       -- disorganized thinking
  cam_positive        BOOLEAN,                       -- computed at write time
  -- SOFA components (each 0-4)
  sofa_resp           INTEGER,
  sofa_coag           INTEGER,
  sofa_liver          INTEGER,
  sofa_cardio         INTEGER,
  sofa_cns            INTEGER,
  sofa_renal          INTEGER,
  sofa_total          INTEGER,                       -- 0..24
  -- CPOT (Critical-Care Pain Observation Tool) — pain in unable-to-self-report
  cpot_facial         INTEGER,                       -- 0-2
  cpot_movement       INTEGER,                       -- 0-2
  cpot_muscle_tension INTEGER,                       -- 0-2
  cpot_vent_compliance INTEGER,                      -- 0-2 (or vocalization if extubated)
  cpot_total          INTEGER,                       -- 0..8

  notes               TEXT,
  recorded_by         UUID,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icu_assess_admission
  ON icu_assessments(icu_admission_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_icu_assess_kind
  ON icu_assessments(icu_admission_id, assessment_kind, recorded_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- 4. ABCDEF DAILY BUNDLES — the ICU Liberation compliance grid
-- ════════════════════════════════════════════════════════════════════
--
-- One row per (icu_admission_id, bundle_date). Six booleans + a "why
-- not" reason per element. SCCM measures bundle adherence as
-- "all-or-nothing" — a unit's headline metric is "% of patient-days
-- with all 6 elements completed". Surfacing element-level gaps is the
-- whole point.

CREATE TABLE IF NOT EXISTS icu_daily_bundles (
  id                  SERIAL PRIMARY KEY,
  icu_admission_id    INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  bundle_date         DATE NOT NULL DEFAULT CURRENT_DATE,

  -- A — Awakening trial (sedation interruption when possible)
  a_awakening_done    BOOLEAN NOT NULL DEFAULT false,
  a_awakening_reason_skipped TEXT,
  -- B — Breathing trial (SBT)
  b_breathing_done    BOOLEAN NOT NULL DEFAULT false,
  b_breathing_reason_skipped TEXT,
  b_breathing_outcome VARCHAR(20),                   -- 'extubated' / 'failed' / 'tolerated' / 'na'
  -- C — Choice of analgesia + sedation (per protocol)
  c_choice_done       BOOLEAN NOT NULL DEFAULT false,
  c_protocol_followed BOOLEAN,
  -- D — Delirium assess + manage (CAM-ICU done, results acted on)
  d_delirium_assessed BOOLEAN NOT NULL DEFAULT false,
  d_delirium_positive BOOLEAN,
  d_delirium_managed  BOOLEAN,                       -- non-pharm + pharm steps documented
  -- E — Early mobility / exercise
  e_mobility_done     BOOLEAN NOT NULL DEFAULT false,
  e_mobility_level    VARCHAR(30),                   -- 'passive_rom' / 'active_rom' / 'sit_edge' / 'stand' / 'walk' / 'na'
  e_mobility_reason_skipped TEXT,
  -- F — Family engagement / empowerment
  f_family_done       BOOLEAN NOT NULL DEFAULT false,
  f_family_method     VARCHAR(30),                   -- 'rounds_at_bedside' / 'video_call' / 'in_person_meeting' / 'phone'

  -- All-or-nothing bundle compliance for this patient-day.
  bundle_complete     BOOLEAN NOT NULL DEFAULT false,
  -- Computed % of elements completed (0..100); nullable until first save
  bundle_pct          INTEGER,

  recorded_by         UUID,
  notes               TEXT,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (icu_admission_id, bundle_date)
);

CREATE INDEX IF NOT EXISTS idx_icu_bundle_date
  ON icu_daily_bundles(tenant_id, bundle_date);
CREATE INDEX IF NOT EXISTS idx_icu_bundle_admission
  ON icu_daily_bundles(icu_admission_id, bundle_date DESC);

-- ════════════════════════════════════════════════════════════════════
-- VIEWS — running running totals + 24h dashboards
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW icu_24h_io_summary AS
SELECT
  icu_admission_id,
  DATE(recorded_at) AS day,
  SUM(COALESCE(iv_fluids_ml, 0))      AS iv_fluids_ml,
  SUM(COALESCE(oral_intake_ml, 0))    AS oral_intake_ml,
  SUM(COALESCE(blood_products_ml, 0)) AS blood_products_ml,
  SUM(COALESCE(urine_output_ml, 0))   AS urine_output_ml,
  SUM(COALESCE(drain_output_ml, 0))   AS drain_output_ml,
  SUM(COALESCE(ng_aspirate_ml, 0))    AS ng_aspirate_ml,
  SUM(COALESCE(net_balance_ml, 0))    AS net_balance_ml,
  COUNT(*)::int                       AS entries_logged
FROM icu_flowsheet_entries
GROUP BY icu_admission_id, DATE(recorded_at);

-- Bundle compliance dashboard (rolling 30 days)
CREATE OR REPLACE VIEW icu_bundle_30d AS
SELECT
  tenant_id,
  bundle_date,
  COUNT(*)::int AS patient_days,
  COUNT(*) FILTER (WHERE bundle_complete)::int AS complete_days,
  ROUND(100.0 * COUNT(*) FILTER (WHERE bundle_complete) / NULLIF(COUNT(*), 0), 1) AS adherence_pct,
  COUNT(*) FILTER (WHERE a_awakening_done)::int AS a_done,
  COUNT(*) FILTER (WHERE b_breathing_done)::int AS b_done,
  COUNT(*) FILTER (WHERE c_choice_done)::int    AS c_done,
  COUNT(*) FILTER (WHERE d_delirium_assessed)::int AS d_done,
  COUNT(*) FILTER (WHERE e_mobility_done)::int  AS e_done,
  COUNT(*) FILTER (WHERE f_family_done)::int    AS f_done
FROM icu_daily_bundles
WHERE bundle_date > CURRENT_DATE - INTERVAL '30 days'
GROUP BY tenant_id, bundle_date
ORDER BY bundle_date DESC;

COMMIT;
