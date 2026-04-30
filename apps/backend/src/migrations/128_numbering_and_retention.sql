-- Migration 128: Phase E2 — first-class numbering series + data
-- retention policies.
--
-- Tables:
--   1. numbering_series — per-tenant configurable counters with
--      printf-style format templates. Replaces ad-hoc COUNT(*)+1
--      patterns scattered across services. The bump itself is atomic
--      via "UPDATE ... SET current_value = current_value + 1 RETURNING".
--   2. data_retention_policies — first-class config for how long each
--      table's rows are kept. Linked optionally to a DataProcessingActivity
--      (E1) so the lawful basis is auditable. Erasure / archival jobs
--      consult this instead of scattered constants.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. numbering_series — per-tenant printf-style counters
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS numbering_series (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code               VARCHAR(80) NOT NULL,
  display_name       VARCHAR(255) NOT NULL,
  -- printf-template: {YYYY} {YY} {MM} {DD} {SEQ} are substituted at next-number time.
  -- Example: 'INV-{YYYY}-{SEQ}' with padding 6 -> 'INV-2026-000042'
  format_template    VARCHAR(120) NOT NULL,
  current_value      BIGINT NOT NULL DEFAULT 0,
  starting_value     BIGINT NOT NULL DEFAULT 0,
  padding            INTEGER NOT NULL DEFAULT 0
    CHECK (padding BETWEEN 0 AND 20),
  -- Optional reset cadence: 'never' / 'yearly' / 'monthly' / 'daily'
  reset_cadence      VARCHAR(20) NOT NULL DEFAULT 'never'
    CHECK (reset_cadence IN ('never', 'yearly', 'monthly', 'daily')),
  last_reset_at      TIMESTAMPTZ,
  status             VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_numbering_tenant_status
  ON numbering_series (tenant_id, status, code);

-- ---------------------------------------------------------------------------
-- 2. data_retention_policies — first-class retention config
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_retention_policies (
  id                       SERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_code              VARCHAR(80) NOT NULL,
  applies_to_table         VARCHAR(120) NOT NULL,
  display_name             VARCHAR(255) NOT NULL,
  description              TEXT,
  retention_days           INTEGER NOT NULL CHECK (retention_days >= 0),
  -- 'erase' deletes the row; 'anonymise' nulls PHI columns; 'archive' moves
  -- to cold storage (caller decides what cold storage means).
  action                   VARCHAR(20) NOT NULL DEFAULT 'erase'
    CHECK (action IN ('erase', 'anonymise', 'archive')),
  basis                    TEXT NOT NULL,
  legal_hold_aware         BOOLEAN NOT NULL DEFAULT true,
  data_processing_activity_id INTEGER REFERENCES data_processing_activities(id) ON DELETE SET NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, policy_code),
  UNIQUE (tenant_id, applies_to_table)
);

CREATE INDEX IF NOT EXISTS idx_drp_tenant_status
  ON data_retention_policies (tenant_id, status, applies_to_table);
CREATE INDEX IF NOT EXISTS idx_drp_dpa
  ON data_retention_policies (data_processing_activity_id)
  WHERE data_processing_activity_id IS NOT NULL;

COMMIT;
