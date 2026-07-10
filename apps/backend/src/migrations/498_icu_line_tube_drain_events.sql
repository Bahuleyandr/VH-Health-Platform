-- NL-14 P1: ICU line/tube/drain lifecycle events.
--
-- Only central_line, urinary_catheter, and ventilator map to N6-6
-- device_presence_logs. Other presence kinds remain ICU chart facts.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_line_tube_drain_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  presence_kind VARCHAR(40) NOT NULL,
  display_label VARCHAR(120),
  site VARCHAR(120),
  denominator_device_type VARCHAR(40),
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ(6),
  start_reason TEXT,
  stop_reason TEXT,
  inserted_by UUID,
  removed_by UUID,
  source VARCHAR(40) NOT NULL DEFAULT 'manual',
  device_presence_log_id BIGINT REFERENCES device_presence_logs(id) ON DELETE SET NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT icu_ltd_presence_kind_check CHECK (
    presence_kind IN (
      'central_line',
      'urinary_catheter',
      'ventilator',
      'ett',
      'tracheostomy',
      'arterial_line',
      'drain',
      'feeding_tube',
      'dialysis_access',
      'oxygen_device'
    )
  ),
  CONSTRAINT icu_ltd_denominator_check CHECK (
    denominator_device_type IS NULL
    OR denominator_device_type IN ('central_line', 'urinary_catheter', 'ventilator')
  ),
  CONSTRAINT icu_ltd_denominator_kind_check CHECK (
    denominator_device_type IS NULL
    OR presence_kind IN ('central_line', 'urinary_catheter', 'ventilator', 'ett', 'tracheostomy')
  ),
  CONSTRAINT icu_ltd_source_check CHECK (source IN ('manual', 'handover', 'device_association')),
  CONSTRAINT icu_ltd_time_check CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  CONSTRAINT fk_icu_ltd_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_icu_ltd_admission
  ON icu_line_tube_drain_events (tenant_id, icu_admission_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_icu_ltd_active
  ON icu_line_tube_drain_events (tenant_id, icu_admission_id, presence_kind)
  WHERE stopped_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_icu_ltd_denominator
  ON icu_line_tube_drain_events (tenant_id, denominator_device_type, started_at, stopped_at)
  WHERE denominator_device_type IS NOT NULL;

ALTER TABLE icu_line_tube_drain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_line_tube_drain_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_line_tube_drain_events;
CREATE POLICY tenant_isolation ON icu_line_tube_drain_events
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
  );

COMMIT;
