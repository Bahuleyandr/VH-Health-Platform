-- Migration 131: Phase F2 — pain / fall-risk / growth-chart assessments.
--
-- Three first-class clinical assessment entities. Replaces the ad-hoc
-- inlining of pain scores in clinical_notes / vitals_chart and the
-- absence of a structured fall-risk and growth-chart store.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. pain_assessments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pain_assessments (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid                 UUID NOT NULL,
  encounter_id                INTEGER,
  -- Standard pain scales — caller picks one per record:
  --   NRS              — Numeric Rating Scale (0..10)
  --   WONG_BAKER_FACES — paediatric (0..10 mapped from face icons)
  --   FLACC            — Face/Legs/Activity/Cry/Consolability (0..10) — non-verbal
  --   PAINAD           — Pain Assessment in Advanced Dementia (0..10)
  --   VAS              — Visual Analog Scale (0..10)
  scale                       VARCHAR(40) NOT NULL
    CHECK (scale IN ('NRS', 'WONG_BAKER_FACES', 'FLACC', 'PAINAD', 'VAS')),
  score                       NUMERIC(4, 1) NOT NULL
    CHECK (score >= 0 AND score <= 10),
  location                    VARCHAR(120),
  character                   VARCHAR(80),
  context                     VARCHAR(40)
    CHECK (context IS NULL OR context IN ('rest', 'movement', 'on_pressure', 'with_breathing')),
  interventions               JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes                       TEXT,
  recorded_by                 UUID,
  recorded_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pain_patient_recorded
  ON pain_assessments (patient_uid, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_pain_encounter
  ON pain_assessments (encounter_id, recorded_at DESC) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pain_high_score
  ON pain_assessments (tenant_id, score, recorded_at DESC)
  WHERE score >= 7;

-- ---------------------------------------------------------------------------
-- 2. fall_risk_assessments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fall_risk_assessments (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid                 UUID NOT NULL,
  encounter_id                INTEGER,
  scale                       VARCHAR(40) NOT NULL
    CHECK (scale IN ('MORSE', 'HENDRICH_II', 'JOHNS_HOPKINS', 'STRATIFY', 'HUMPTY_DUMPTY')),
  -- Score is the per-scale raw integer (Morse: 0-125; Hendrich: 0-16;
  -- Johns Hopkins: 0-25; STRATIFY: 0-5; Humpty Dumpty: 7-23). Callers
  -- supply both score + risk_level (computed by them per scale).
  score                       INTEGER NOT NULL CHECK (score >= 0),
  risk_level                  VARCHAR(20) NOT NULL
    CHECK (risk_level IN ('low', 'medium', 'high', 'very_high')),
  -- Domain-specific factor flags packed as JSON to avoid 50 CHECK columns.
  -- e.g. for Morse: { history_of_falls, secondary_diagnosis, ambulatory_aid,
  -- iv, gait, mental_status }.
  factors                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  interventions               JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes                       TEXT,
  recorded_by                 UUID,
  recorded_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fall_patient_recorded
  ON fall_risk_assessments (patient_uid, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_fall_encounter
  ON fall_risk_assessments (encounter_id, recorded_at DESC) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fall_high_risk
  ON fall_risk_assessments (tenant_id, risk_level, recorded_at DESC)
  WHERE risk_level IN ('high', 'very_high');

-- ---------------------------------------------------------------------------
-- 3. growth_charts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS growth_charts (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid                 UUID NOT NULL,
  encounter_id                INTEGER,
  -- Percentile reference dataset:
  --   WHO_0_5    — WHO Child Growth Standards, 0..5y
  --   IAP_5_18   — Indian Academy of Paediatrics, 5..18y
  --   CDC_2_20   — CDC Growth Charts, 2..20y
  --   FENTON     — Fenton preterm chart
  reference_dataset           VARCHAR(40) NOT NULL
    CHECK (reference_dataset IN ('WHO_0_5', 'IAP_5_18', 'CDC_2_20', 'FENTON')),
  age_in_days                 INTEGER NOT NULL CHECK (age_in_days >= 0),
  height_cm                   NUMERIC(6, 2),
  weight_kg                   NUMERIC(6, 3),
  head_circumference_cm       NUMERIC(5, 2),
  mid_upper_arm_circumference_cm NUMERIC(5, 2),
  bmi                         NUMERIC(5, 2),
  -- Caller computes these against the chosen reference; persisting
  -- them avoids re-deriving on every chart render.
  percentiles                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  z_scores                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- WHO classifications: 'severe_acute_malnutrition', 'moderate_acute_malnutrition',
  -- 'stunting', 'wasting', 'overweight', 'obesity', 'normal'
  classification              VARCHAR(60),
  notes                       TEXT,
  recorded_by                 UUID,
  recorded_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_growth_patient_recorded
  ON growth_charts (patient_uid, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_encounter
  ON growth_charts (encounter_id, recorded_at DESC) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_growth_classification
  ON growth_charts (tenant_id, classification, recorded_at DESC)
  WHERE classification IN ('severe_acute_malnutrition', 'moderate_acute_malnutrition', 'stunting', 'wasting');

COMMIT;
