-- NL-7 P2: cold-chain excursions and advisory blood-bank review flags.
-- Environmental excursions never mutate stock state; blood-bank linkage is
-- advisory-only and surfaces a human review flag.

CREATE TABLE IF NOT EXISTS cold_chain_excursions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE NO ACTION,
  unit_id INTEGER NOT NULL REFERENCES cold_chain_units(id) ON DELETE RESTRICT,
  breach_started_at TIMESTAMPTZ(6) NOT NULL,
  opened_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  returned_in_range_at TIMESTAMPTZ(6),
  closed_at TIMESTAMPTZ(6),
  last_out_of_range_at TIMESTAMPTZ(6),
  breach_direction VARCHAR(16),
  peak_temp_c NUMERIC(5,2),
  min_seen_temp_c NUMERIC(5,2),
  max_seen_temp_c NUMERIC(5,2),
  duration_minutes INTEGER,
  severity VARCHAR(24) NOT NULL DEFAULT 'warning',
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ(6),
  corrective_action TEXT,
  disposition_note TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  notification_count INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  sla_instance_id UUID REFERENCES workflow_sla_instances(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cold_chain_excursions_direction_check CHECK (breach_direction IS NULL OR breach_direction IN ('low', 'high', 'silent')),
  CONSTRAINT cold_chain_excursions_severity_check CHECK (severity IN ('warning', 'critical')),
  CONSTRAINT cold_chain_excursions_status_check CHECK (status IN ('open', 'acknowledged', 'closed')),
  CONSTRAINT cold_chain_excursions_corrective_close_check CHECK (
    status <> 'closed'
    OR (corrective_action IS NOT NULL AND length(trim(corrective_action)) > 0)
  ),
  CONSTRAINT cold_chain_excursions_closed_at_check CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cold_chain_excursions_open_unit
  ON cold_chain_excursions (tenant_id, unit_id)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_cold_chain_excursions_tenant_status
  ON cold_chain_excursions (tenant_id, status, severity, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_cold_chain_excursions_unit_opened
  ON cold_chain_excursions (tenant_id, unit_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS cold_chain_blood_bank_review_flags (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE NO ACTION,
  excursion_id BIGINT NOT NULL REFERENCES cold_chain_excursions(id) ON DELETE CASCADE,
  unit_id INTEGER NOT NULL REFERENCES cold_chain_units(id) ON DELETE RESTRICT,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  review_note TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cold_chain_review_flags_status_check CHECK (status IN ('open', 'reviewed', 'dismissed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cold_chain_review_flags_excursion
  ON cold_chain_blood_bank_review_flags (tenant_id, excursion_id);

CREATE INDEX IF NOT EXISTS idx_cold_chain_review_flags_status
  ON cold_chain_blood_bank_review_flags (tenant_id, status, created_at DESC);

ALTER TABLE cold_chain_excursions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cold_chain_excursions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cold_chain_excursions;
CREATE POLICY tenant_isolation ON cold_chain_excursions
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

ALTER TABLE cold_chain_blood_bank_review_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE cold_chain_blood_bank_review_flags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cold_chain_blood_bank_review_flags;
CREATE POLICY tenant_isolation ON cold_chain_blood_bank_review_flags
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
