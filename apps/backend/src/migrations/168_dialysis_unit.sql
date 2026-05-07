-- Migration 168: Dialysis unit (HD/CRRT) sessions + vascular access +
-- adequacy (Sprint 22).
--
-- Closes the last service-line gap. ESRD patients are a stable but
-- demanding cohort: ~3 sessions/week each, every-30-min vitals
-- during the run, monthly Kt/V adequacy + serology, and quarterly
-- vascular access surveillance.
--
-- Schema layout:
-- 1. dialysis_patients — HD/PD/CRRT enrolment header. One row per
--    patient on the unit's roster.
-- 2. vascular_access — current access type + surveillance dates.
--    Multiple per patient over time; "active" flag points at the
--    one currently in use.
-- 3. dialysis_sessions — per-treatment header (date, machine, vitals
--    pre/post, anti-coagulation, adequacy result if measured).
-- 4. dialysis_intra_obs — every-30-min during the run (BP, pulse,
--    UF rate, transmembrane pressure, blood-flow rate, events).
-- 5. dialysis_serology — Hep-B / HCV / HIV surveillance with WHO
--    grading + isolation flag.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- DIALYSIS PATIENT ENROLMENT
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dialysis_patients (
  id                          SERIAL PRIMARY KEY,
  patient_uid                 UUID NOT NULL,
  enrolled_at                 DATE NOT NULL DEFAULT CURRENT_DATE,
  modality                    VARCHAR(20) NOT NULL DEFAULT 'hd'
    CHECK (modality IN ('hd', 'hdf', 'pd_capd', 'pd_apd', 'crrt', 'sled')),
  schedule_pattern            VARCHAR(20),                -- 'mwf' / 'tts' / 'daily' / 'sos' / 'crrt_continuous'
  prescribed_minutes          INTEGER,                    -- typical session length (minutes)
  prescribed_dialyser         VARCHAR(80),                -- e.g. 'F60' / 'rev280G' / 'PrismaFlex M150'
  -- Dry weight is the single most-tracked clinical value. Update via
  -- separate endpoint that snapshots history (kept for trending).
  dry_weight_kg               NUMERIC(5, 2),
  dry_weight_set_at           TIMESTAMPTZ,
  -- Anti-coagulation default for this patient
  anticoag_default            VARCHAR(20) DEFAULT 'heparin'
    CHECK (anticoag_default IN ('heparin', 'lmwh', 'citrate', 'none', 'argatroban')),
  -- Bloodborne pathogen status drives isolation-room assignment
  hbsag_status                VARCHAR(20) DEFAULT 'negative'
    CHECK (hbsag_status IN ('negative', 'positive', 'pending', 'unknown')),
  hcv_status                  VARCHAR(20) DEFAULT 'negative'
    CHECK (hcv_status IN ('negative', 'positive', 'pending', 'unknown')),
  hiv_status                  VARCHAR(20) DEFAULT 'negative'
    CHECK (hiv_status IN ('negative', 'positive', 'pending', 'unknown')),
  isolation_required          BOOLEAN GENERATED ALWAYS AS (
    hbsag_status = 'positive' OR hcv_status = 'positive' OR hiv_status = 'positive'
  ) STORED,

  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'transferred', 'transplanted', 'expired', 'lost_to_followup')),

  notes                       TEXT,
  tenant_id                   UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialysis_patients_active
  ON dialysis_patients(tenant_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_dialysis_patients_isolation
  ON dialysis_patients(tenant_id) WHERE isolation_required = true;
CREATE INDEX IF NOT EXISTS idx_dialysis_patients_pat
  ON dialysis_patients(patient_uid);

-- ════════════════════════════════════════════════════════════════════
-- VASCULAR ACCESS
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vascular_access (
  id                  SERIAL PRIMARY KEY,
  dialysis_patient_id INTEGER NOT NULL REFERENCES dialysis_patients(id) ON DELETE CASCADE,
  access_type         VARCHAR(40) NOT NULL CHECK (access_type IN (
    'avf_radiocephalic', 'avf_brachiocephalic', 'avf_brachiobasilic',
    'avg_forearm', 'avg_upper_arm', 'avg_thigh',
    'cvc_temporary_ij', 'cvc_temporary_femoral',
    'cvc_tunneled_ij', 'cvc_tunneled_subclavian',
    'pd_catheter')),
  side                VARCHAR(10) CHECK (side IN ('left', 'right', 'na')),
  created_date        DATE NOT NULL,
  first_used_date     DATE,
  active              BOOLEAN NOT NULL DEFAULT true,
  abandoned_date      DATE,
  abandoned_reason    VARCHAR(60),                    -- 'thrombosis' / 'infection' / 'aneurysm' / 'steal' / 'transplant' / 'other'
  -- Surveillance
  last_qa_check_date  DATE,                           -- access flow QA
  qa_flow_ml_min      INTEGER,                        -- < 600 mL/min in AVF = surveillance trigger
  last_doppler_date   DATE,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Only one active access per patient at a time.
  UNIQUE (dialysis_patient_id, active) DEFERRABLE INITIALLY DEFERRED
);

-- Replace the strict UNIQUE above (which would only allow ONE row per
-- patient regardless of active value) with a partial unique that
-- enforces "one active row" while allowing many inactive ones.
ALTER TABLE vascular_access DROP CONSTRAINT IF EXISTS vascular_access_dialysis_patient_id_active_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vascular_access_one_active
  ON vascular_access(dialysis_patient_id) WHERE active;

CREATE INDEX IF NOT EXISTS idx_vascular_access_patient
  ON vascular_access(dialysis_patient_id, active DESC, created_date DESC);

-- ════════════════════════════════════════════════════════════════════
-- DIALYSIS SESSION (one row per treatment)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dialysis_sessions (
  id                      SERIAL PRIMARY KEY,
  dialysis_patient_id     INTEGER NOT NULL REFERENCES dialysis_patients(id) ON DELETE CASCADE,
  vascular_access_id      INTEGER REFERENCES vascular_access(id),
  session_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  machine_no              VARCHAR(40),
  station_no              VARCHAR(20),
  modality                VARCHAR(20) NOT NULL,
  dialyser                VARCHAR(80),
  -- Reuse # for re-processed dialysers. India still does this.
  reuse_count             INTEGER,

  -- Times
  scheduled_start_at      TIMESTAMPTZ,
  actual_start_at         TIMESTAMPTZ,
  actual_end_at           TIMESTAMPTZ,
  duration_min            INTEGER,                   -- materialised at end-of-run

  -- Pre-dialysis vitals + weight
  pre_weight_kg           NUMERIC(5, 2),
  pre_bp_systolic         INTEGER,
  pre_bp_diastolic        INTEGER,
  pre_pulse               INTEGER,
  pre_temp_c              NUMERIC(4, 1),

  -- Post-dialysis vitals + weight
  post_weight_kg          NUMERIC(5, 2),
  post_bp_systolic        INTEGER,
  post_bp_diastolic       INTEGER,
  post_pulse              INTEGER,
  post_temp_c             NUMERIC(4, 1),

  -- UF (ultrafiltration) prescription + actual
  prescribed_uf_l         NUMERIC(4, 2),
  actual_uf_l             NUMERIC(4, 2),

  -- Anti-coagulation
  anticoag                VARCHAR(20),
  anticoag_initial_dose   VARCHAR(40),
  anticoag_maintenance    VARCHAR(40),

  -- Adequacy (Kt/V is the gold-standard urea reduction metric;
  -- targets ≥1.2 for thrice-weekly HD per KDOQI).
  ktv_calculated          NUMERIC(4, 2),
  urea_pre_mg_dl          INTEGER,
  urea_post_mg_dl         INTEGER,
  urr_pct                 INTEGER,                   -- urea reduction ratio

  -- Adverse events flagged for trend analysis
  intra_dialytic_hypotension BOOLEAN NOT NULL DEFAULT false,
  cramps                   BOOLEAN NOT NULL DEFAULT false,
  bleeding                 BOOLEAN NOT NULL DEFAULT false,
  clotting                 BOOLEAN NOT NULL DEFAULT false,
  early_termination        BOOLEAN NOT NULL DEFAULT false,
  early_termination_reason TEXT,

  status                   VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'no_show')),

  conducted_by             UUID,
  supervised_by            UUID,
  notes                    TEXT,

  tenant_id                UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialysis_sess_patient
  ON dialysis_sessions(dialysis_patient_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_dialysis_sess_status
  ON dialysis_sessions(tenant_id, status, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_dialysis_sess_today
  ON dialysis_sessions(tenant_id, session_date) WHERE status = 'in_progress';

-- ════════════════════════════════════════════════════════════════════
-- INTRA-DIALYSIS OBSERVATIONS (every 30 min during the run)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dialysis_intra_obs (
  id                  SERIAL PRIMARY KEY,
  session_id          INTEGER NOT NULL REFERENCES dialysis_sessions(id) ON DELETE CASCADE,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Vitals
  bp_systolic         INTEGER,
  bp_diastolic        INTEGER,
  pulse               INTEGER,
  spo2                INTEGER,
  temp_c              NUMERIC(4, 1),
  -- Machine readings
  blood_flow_ml_min   INTEGER,                       -- target 250-450 for HD
  uf_rate_ml_hr       INTEGER,                       -- avoid > 13 mL/kg/hr
  tmp_mmhg            INTEGER,                       -- transmembrane pressure
  arterial_pressure   INTEGER,
  venous_pressure     INTEGER,
  conductivity_ms_cm  NUMERIC(4, 2),
  -- Volume
  uf_total_ml         INTEGER,                       -- running total
  -- Free-text events / interventions
  event_note          TEXT,
  -- Intervention given (e.g. saline bolus for hypotension)
  intervention        VARCHAR(80),
  intervention_dose   VARCHAR(40),

  recorded_by         UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialysis_obs_session
  ON dialysis_intra_obs(session_id, recorded_at);

-- ════════════════════════════════════════════════════════════════════
-- SEROLOGY SURVEILLANCE
-- ════════════════════════════════════════════════════════════════════
--
-- ICMR mandates baseline + 3-monthly Hep-B/HCV + annual HIV in HD
-- units. Sero-conversion = isolation room + cluster investigation.

CREATE TABLE IF NOT EXISTS dialysis_serology (
  id                  SERIAL PRIMARY KEY,
  dialysis_patient_id INTEGER NOT NULL REFERENCES dialysis_patients(id) ON DELETE CASCADE,
  test_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  hbsag               VARCHAR(20) CHECK (hbsag IN ('negative', 'positive', 'reactive', 'pending', 'na')),
  hbs_titre           NUMERIC(8, 2),                 -- IU/L for vaccinated patients
  anti_hcv            VARCHAR(20) CHECK (anti_hcv IN ('negative', 'positive', 'reactive', 'pending', 'na')),
  hcv_pcr             VARCHAR(20),                   -- 'detected' / 'not_detected' / 'pending'
  hiv                 VARCHAR(20) CHECK (hiv IN ('negative', 'positive', 'reactive', 'pending', 'na')),
  -- Sero-conversion flag (computed at write time vs prior result)
  is_seroconversion   BOOLEAN NOT NULL DEFAULT false,
  reported_by         UUID,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialysis_serology_patient
  ON dialysis_serology(dialysis_patient_id, test_date DESC);
CREATE INDEX IF NOT EXISTS idx_dialysis_serology_seroconv
  ON dialysis_serology(dialysis_patient_id) WHERE is_seroconversion;

-- ════════════════════════════════════════════════════════════════════
-- DASHBOARD VIEWS
-- ════════════════════════════════════════════════════════════════════

-- Today's roster at a glance
CREATE OR REPLACE VIEW dialysis_today AS
SELECT
  s.tenant_id,
  s.id AS session_id,
  s.dialysis_patient_id,
  s.station_no,
  s.machine_no,
  s.scheduled_start_at,
  s.actual_start_at,
  s.actual_end_at,
  s.status,
  p.patient_uid,
  p.modality,
  p.isolation_required,
  va.access_type,
  s.intra_dialytic_hypotension,
  s.cramps
FROM dialysis_sessions s
JOIN dialysis_patients p ON p.id = s.dialysis_patient_id
LEFT JOIN vascular_access va ON va.id = s.vascular_access_id
WHERE s.session_date = CURRENT_DATE;

-- Adequacy roll-up (last 30 days, mean Kt/V per patient)
CREATE OR REPLACE VIEW dialysis_adequacy_30d AS
SELECT
  s.tenant_id,
  s.dialysis_patient_id,
  COUNT(*)::int                         AS sessions_30d,
  COUNT(s.ktv_calculated)::int          AS adequacy_measurements,
  ROUND(AVG(s.ktv_calculated)::numeric, 2) AS mean_ktv,
  ROUND(AVG(s.urr_pct)::numeric, 1)        AS mean_urr_pct,
  COUNT(*) FILTER (WHERE s.intra_dialytic_hypotension)::int AS hypotension_episodes,
  COUNT(*) FILTER (WHERE s.early_termination)::int          AS early_terms
FROM dialysis_sessions s
WHERE s.session_date > CURRENT_DATE - INTERVAL '30 days'
  AND s.status = 'completed'
GROUP BY s.tenant_id, s.dialysis_patient_id;

COMMIT;
