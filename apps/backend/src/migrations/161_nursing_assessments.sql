-- Migration 161: Nursing assessment scoring (Sprint 15).
--
-- NABH 5.x mandates that every IP admission has these scoring tools
-- captured at admission and at defined intervals:
--   - NEWS2 (National Early Warning Score 2) — vitals-driven score
--     that flips amber/red automatically. Computed from RR / SpO2 /
--     supplemental O2 / temp / SBP / HR / consciousness.
--   - Braden Scale — pressure injury risk. 6 sub-scores, total 6-23.
--     Lower = higher risk.
--   - Morse Falls Scale — fall risk. 6 yes/no items + 1 graded.
--     Total 0-125; ≥45 high.
--   - Sepsis screen — SIRS / qSOFA-style red-flag list.
--
-- We store one row per assessment instance + an `assessment_kind`
-- tag so a single table covers all four scoring tools. Component
-- scores live in `inputs` JSONB; `total_score` + `band` are computed
-- service-side and stored.

BEGIN;

CREATE TABLE IF NOT EXISTS nursing_assessments (
  id                     SERIAL PRIMARY KEY,
  patient_uid            UUID NOT NULL,
  admission_id           INTEGER,
  assessment_kind        VARCHAR(20) NOT NULL
    CHECK (assessment_kind IN ('news2', 'braden', 'morse', 'sepsis_screen')),
  assessed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessed_by            UUID,
  assessed_by_name       VARCHAR(160),
  -- Component scores per the kind. NEWS2: rr/spo2/temp/sbp/hr/conscious/o2
  -- Braden: sensory/moisture/activity/mobility/nutrition/friction
  -- Morse: history_falls/secondary_dx/ambulatory_aid/iv_therapy/gait/mental
  -- Sepsis: rr_over_22/altered_mentation/sbp_under_100/temp_abnormal/
  --         hr_over_90/wbc_abnormal/lactate_over_2/source_suspected
  inputs                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Computed fields stored so the alert tier doesn't need recomputation
  -- on every read, and the scoring algorithm version is locked at
  -- write time (regression protection if guidelines change).
  total_score            INTEGER,
  band                   VARCHAR(40),
  scoring_version        VARCHAR(20) NOT NULL DEFAULT 'v1',
  -- Free-text notes + recommended actions for the doctor's review.
  recommended_actions    TEXT[],
  notes                  TEXT,
  -- When the next reassessment should happen (NEWS2 escalates the
  -- frequency based on band: low = 12h, medium = 4h, high = 1h).
  next_assessment_due_at TIMESTAMPTZ,
  tenant_id              UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursing_assessments_patient
  ON nursing_assessments(patient_uid, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_nursing_assessments_admission
  ON nursing_assessments(admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nursing_assessments_kind
  ON nursing_assessments(assessment_kind, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_nursing_assessments_due
  ON nursing_assessments(tenant_id, next_assessment_due_at)
  WHERE next_assessment_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nursing_assessments_high_risk
  ON nursing_assessments(tenant_id, assessment_kind, band)
  WHERE band IN ('high', 'critical', 'high_risk', 'sepsis_likely');

COMMIT;
