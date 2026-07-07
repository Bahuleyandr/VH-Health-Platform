-- N6-13 CSSD instrument tracking: issue, theatre-use, return, and reprocess loop.

CREATE TABLE IF NOT EXISTS set_issue_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  issue_code VARCHAR(80) NOT NULL,
  instrument_set_id BIGINT NOT NULL,
  ot_schedule_id INTEGER NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'issued',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by UUID,
  theatre_use_started_at TIMESTAMPTZ,
  theatre_use_started_by UUID,
  returned_at TIMESTAMPTZ,
  returned_by UUID,
  decontaminated_at TIMESTAMPTZ,
  decontaminated_by UUID,
  sterilized_at TIMESTAMPTZ,
  sterilized_by UUID,
  sterilization_load_id BIGINT,
  return_due_at TIMESTAMPTZ,
  return_condition VARCHAR(40),
  issue_warning_codes TEXT[] NOT NULL DEFAULT '{}'::text[],
  warn_only BOOLEAN NOT NULL DEFAULT true,
  enforcement_enabled BOOLEAN NOT NULL DEFAULT false,
  contamination_notes TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT set_issue_log_status_check
    CHECK (status IN (
      'issued',
      'in_theatre',
      'returned',
      'awaiting_sterilization',
      'sterilized',
      'sterilization_failed',
      'cancelled'
    )),
  CONSTRAINT set_issue_log_return_condition_check
    CHECK (return_condition IS NULL OR return_condition IN ('intact', 'missing_item', 'damaged', 'contaminated')),
  CONSTRAINT fk_set_issue_log_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_set_issue_log_instrument_set
    FOREIGN KEY (instrument_set_id) REFERENCES instrument_sets(id) ON DELETE RESTRICT,
  CONSTRAINT fk_set_issue_log_ot_schedule
    FOREIGN KEY (ot_schedule_id) REFERENCES ot_schedules(id) ON DELETE RESTRICT,
  CONSTRAINT fk_set_issue_log_sterilization_load
    FOREIGN KEY (sterilization_load_id) REFERENCES sterilization_loads(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_set_issue_log_tenant_code
  ON set_issue_log (tenant_id, UPPER(issue_code));

CREATE UNIQUE INDEX IF NOT EXISTS ux_set_issue_log_open_set
  ON set_issue_log (tenant_id, instrument_set_id)
  WHERE status IN ('issued', 'in_theatre', 'returned', 'awaiting_sterilization');

CREATE INDEX IF NOT EXISTS idx_set_issue_log_tenant_status
  ON set_issue_log (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_set_issue_log_ot_schedule
  ON set_issue_log (tenant_id, ot_schedule_id, status, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_set_issue_log_overdue_returns
  ON set_issue_log (tenant_id, return_due_at)
  WHERE status IN ('issued', 'in_theatre') AND return_due_at IS NOT NULL;

ALTER TABLE set_issue_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE set_issue_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON set_issue_log;
CREATE POLICY tenant_isolation ON set_issue_log
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
