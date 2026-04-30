-- Migration 127: Phase E1 — DataProcessingActivity (GDPR Art. 30) +
-- breach Art. 33/34 notification tracking + compliance dashboard data.
--
-- Tables:
--   1. data_processing_activities — formal Article 30 register: every
--      processing activity the controller performs, with purposes,
--      lawful basis, data categories, recipients, retention, security.
--      DPIA tracking (Art. 35) co-located.
--
-- ALTERs (additive):
--   data_breaches gains GDPR Art. 33 (regulator notification, 72h)
--   and Art. 34 (data subject notification, "high risk") tracking,
--   plus a soft FK to data_processing_activities and risk-assessment
--   JSON for the impact analysis.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. data_processing_activities — Article 30 record of processing activities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_processing_activities (
  id                            SERIAL PRIMARY KEY,
  tenant_id                     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  activity_code                 VARCHAR(80) NOT NULL,
  display_name                  VARCHAR(255) NOT NULL,
  description                   TEXT,
  -- Art. 30(1)(b): purposes of the processing
  purposes                      TEXT NOT NULL,
  -- Art. 30(1)(c): categories of data subjects + personal data
  data_subject_categories       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  personal_data_categories      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  special_category_data         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Art. 30(1)(d): categories of recipients
  recipient_categories          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Art. 30(1)(e): cross-border transfers
  cross_border_transfers        BOOLEAN NOT NULL DEFAULT false,
  cross_border_destinations     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cross_border_safeguards       TEXT,
  -- Art. 30(1)(f): retention envisaged time limits
  retention_period_days         INTEGER,
  retention_basis               TEXT,
  -- Art. 30(1)(g): general description of technical + organisational measures
  security_measures             TEXT,
  -- Art. 6(1) lawful basis
  lawful_basis                  VARCHAR(40) NOT NULL
    CHECK (lawful_basis IN (
      'consent', 'contract', 'legal_obligation',
      'vital_interests', 'public_task', 'legitimate_interests'
    )),
  legitimate_interests_assessment TEXT,
  -- Art. 35 DPIA tracking
  dpia_required                 BOOLEAN NOT NULL DEFAULT false,
  dpia_completed_at             TIMESTAMPTZ,
  dpia_reference                VARCHAR(255),
  -- Lifecycle
  status                        VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  metadata                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                    UUID,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, activity_code)
);

CREATE INDEX IF NOT EXISTS idx_dpa_tenant_status
  ON data_processing_activities (tenant_id, status, display_name);
CREATE INDEX IF NOT EXISTS idx_dpa_lawful_basis
  ON data_processing_activities (tenant_id, lawful_basis);
CREATE INDEX IF NOT EXISTS idx_dpa_dpia_pending
  ON data_processing_activities (tenant_id, dpia_required)
  WHERE dpia_required = true AND dpia_completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Extend data_breaches with Art. 33/34 notification tracking
-- ---------------------------------------------------------------------------

ALTER TABLE data_breaches
  ADD COLUMN IF NOT EXISTS regulator_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS regulator_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS regulator_jurisdiction VARCHAR(80),
  ADD COLUMN IF NOT EXISTS data_subjects_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS data_subject_notification_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dpa_id INTEGER REFERENCES data_processing_activities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cross_border_impact BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_breach_dpa
  ON data_breaches (dpa_id) WHERE dpa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_breach_regulator_pending
  ON data_breaches (severity, discovered_at)
  WHERE regulator_notified_at IS NULL AND severity IN ('high', 'critical');

COMMIT;
