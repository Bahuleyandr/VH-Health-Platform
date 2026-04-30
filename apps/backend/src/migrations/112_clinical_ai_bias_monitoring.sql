-- Migration 112: bias monitoring — demographic slice telemetry for AI eval
-- and drift canary runs.
--
-- WHO governance guidance for clinical AI explicitly calls out evaluating
-- model performance by age band, sex, language, disease group, and
-- facility — exactly the dimensions a system can show systematic gaps in
-- without an aggregate metric noticing. Migration 062 created
-- clinical_ai_model_eval_runs with aggregate metrics; migration 019
-- created the drift-canary tables. Neither captured demographic slices,
-- so a 70 % pass rate from a canary suite could mask a 35 % pass rate
-- among, say, paediatric Tamil speakers — the bias hole the AI Feature
-- Gap Backlog (S3) calls out.
--
-- This migration:
--   1. Adds slice_attributes JSONB to clinical_ai_canary_cases so each
--      canary case can declare which demographic axes it represents
--      ({age_band, sex, language, disease_group, facility_id}).
--   2. Adds slice_metrics JSONB to clinical_ai_canary_runs +
--      clinical_ai_model_eval_runs so per-slice pass rates are persisted
--      alongside the aggregate.
--   3. Adds bias_signals JSONB to clinical_ai_canary_runs +
--      clinical_ai_model_eval_runs so triggered bias alarms are
--      addressable separately from generic drift.
--
-- Decision-support only: bias signals route to the governance dashboard
-- where the AI eval lead reviews; nothing auto-disables or auto-rolls-back
-- a model. Slice axes are intentionally schema-flexible (JSONB) so a
-- hospital can add a custom dimension (e.g. tribal language, rural vs
-- urban) without a migration.

BEGIN;

ALTER TABLE clinical_ai_canary_cases
  ADD COLUMN IF NOT EXISTS slice_attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE clinical_ai_canary_runs
  ADD COLUMN IF NOT EXISTS slice_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bias_signals JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE clinical_ai_model_eval_runs
  ADD COLUMN IF NOT EXISTS slice_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bias_signals JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_canary_cases_slice_age
  ON clinical_ai_canary_cases ((slice_attributes->>'age_band'));
CREATE INDEX IF NOT EXISTS idx_canary_cases_slice_sex
  ON clinical_ai_canary_cases ((slice_attributes->>'sex'));
CREATE INDEX IF NOT EXISTS idx_canary_cases_slice_language
  ON clinical_ai_canary_cases ((slice_attributes->>'language'));
CREATE INDEX IF NOT EXISTS idx_canary_cases_slice_disease
  ON clinical_ai_canary_cases ((slice_attributes->>'disease_group'));
CREATE INDEX IF NOT EXISTS idx_canary_cases_slice_facility
  ON clinical_ai_canary_cases ((slice_attributes->>'facility_id'));

COMMIT;
