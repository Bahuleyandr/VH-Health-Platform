-- 286_nabh_indicators.sql
--
-- Roadmap Pillar D / item D4 (docs/EPIC_LEVEL_ROADMAP.md) — NABH quality
-- indicator pack. Indicators are COMPUTED from data the platform already
-- captures (admissions, MAR, safety reviews, lab/radiology/pharmacy
-- timestamps, critical-alert acks, infection cases); this table snapshots
-- a period so assessors see frozen, reproducible numbers.

BEGIN;

CREATE TABLE IF NOT EXISTS nabh_indicator_snapshots (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  indicator_code VARCHAR(60) NOT NULL,
  label          VARCHAR(200) NOT NULL,
  value          NUMERIC(14,4),
  numerator      NUMERIC(14,4),
  denominator    NUMERIC(14,4),
  unit           VARCHAR(40),
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_by    UUID,
  computed_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_nabh_indicator_snapshots_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_nabh_indicator_snapshots
    UNIQUE (tenant_id, period_start, period_end, indicator_code)
);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE nabh_indicator_snapshots ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE nabh_indicator_snapshots FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON nabh_indicator_snapshots';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON nabh_indicator_snapshots
      USING (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = app_current_tenant_id_uuid()
      )
      WITH CHECK (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = app_current_tenant_id_uuid()
      )
  $f$;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT 'NABH_INDICATORS_APPLIED', 'nabh_indicator_snapshots', 'nabh_indicator_snapshots',
  jsonb_build_object('migration', '286_nabh_indicators.sql', 'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D4',
    'reason', 'NABH quality indicators computed from captured data; period snapshots for assessor export.'),
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs')
  AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'NABH_INDICATORS_APPLIED');

COMMIT;
