-- NL-7 P3: tenant-scoped biomedical work orders, lifecycle updates, recipients.

CREATE SEQUENCE IF NOT EXISTS biomed_work_order_number_seq;

CREATE TABLE IF NOT EXISTS biomed_work_orders (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  work_order_number VARCHAR(32) NOT NULL DEFAULT (
    'BWO-' || to_char(NOW(), 'YYYYMMDD') || '-' ||
    lpad(nextval('biomed_work_order_number_seq')::text, 6, '0')
  ),
  biomed_device_id INTEGER NOT NULL REFERENCES clinical_ai_biomed_devices(id) ON DELETE CASCADE,
  schedule_id BIGINT REFERENCES biomed_maintenance_schedules(id) ON DELETE SET NULL,
  kind VARCHAR(24) NOT NULL,
  priority VARCHAR(24) NOT NULL DEFAULT 'normal',
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  description TEXT NOT NULL,
  assigned_to_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_uid UUID,
  assigned_to_role VARCHAR(60),
  assigned_vendor VARCHAR(160),
  assigned_by UUID,
  assigned_at TIMESTAMPTZ(6),
  sla_due_at TIMESTAMPTZ(6),
  sla_breached_at TIMESTAMPTZ(6),
  completion_notes TEXT,
  parts_used JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_amount NUMERIC(12,2),
  downtime_started_at TIMESTAMPTZ(6),
  downtime_ended_at TIMESTAMPTZ(6),
  completed_by UUID,
  completed_at TIMESTAMPTZ(6),
  verified_by UUID,
  verified_at TIMESTAMPTZ(6),
  source VARCHAR(32) NOT NULL DEFAULT 'manual',
  source_ref VARCHAR(160),
  due_window_start TIMESTAMPTZ(6),
  due_window_end TIMESTAMPTZ(6),
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT biomed_work_orders_kind_check
    CHECK (kind IN ('preventive', 'corrective', 'calibration', 'inspection', 'condemnation')),
  CONSTRAINT biomed_work_orders_priority_check
    CHECK (priority IN ('normal', 'high', 'urgent')),
  CONSTRAINT biomed_work_orders_status_check
    CHECK (status IN ('open', 'assigned', 'in_progress', 'completed', 'verified', 'cancelled')),
  CONSTRAINT biomed_work_orders_source_check
    CHECK (source IN ('schedule', 'manual', 'device_fault', 'ai_prediction')),
  CONSTRAINT fk_biomed_work_orders_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_biomed_work_orders_tenant_number
  ON biomed_work_orders (tenant_id, work_order_number);

CREATE UNIQUE INDEX IF NOT EXISTS ux_biomed_work_orders_schedule_window
  ON biomed_work_orders (tenant_id, schedule_id, due_window_start)
  WHERE source = 'schedule' AND schedule_id IS NOT NULL AND due_window_start IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_biomed_work_orders_ai_prediction_open
  ON biomed_work_orders (tenant_id, source_ref)
  WHERE source = 'ai_prediction' AND source_ref IS NOT NULL AND status IN ('open', 'assigned', 'in_progress', 'completed');

CREATE UNIQUE INDEX IF NOT EXISTS ux_biomed_work_orders_device_fault_open
  ON biomed_work_orders (tenant_id, biomed_device_id, COALESCE(source_ref, '__device_fault__'))
  WHERE source = 'device_fault' AND status IN ('open', 'assigned', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_biomed_work_orders_queue
  ON biomed_work_orders (tenant_id, status, priority, sla_due_at);

CREATE INDEX IF NOT EXISTS idx_biomed_work_orders_assignee
  ON biomed_work_orders (tenant_id, assigned_to_id, status);

CREATE INDEX IF NOT EXISTS idx_biomed_work_orders_device
  ON biomed_work_orders (tenant_id, biomed_device_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_biomed_maintenance_schedules_last_work_order'
  ) THEN
    ALTER TABLE biomed_maintenance_schedules
      ADD CONSTRAINT fk_biomed_maintenance_schedules_last_work_order
        FOREIGN KEY (last_work_order_id) REFERENCES biomed_work_orders(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS biomed_work_order_updates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  work_order_id BIGINT NOT NULL REFERENCES biomed_work_orders(id) ON DELETE CASCADE,
  previous_status VARCHAR(24),
  status VARCHAR(24) NOT NULL,
  message TEXT,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_uid UUID,
  author_role VARCHAR(60),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT biomed_work_order_updates_status_check
    CHECK (status IN ('open', 'assigned', 'in_progress', 'completed', 'verified', 'cancelled')),
  CONSTRAINT fk_biomed_work_order_updates_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_biomed_work_order_updates_order
  ON biomed_work_order_updates (tenant_id, work_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS biomed_work_order_recipients (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  work_order_id BIGINT NOT NULL REFERENCES biomed_work_orders(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_uid UUID,
  recipient_kind VARCHAR(40) NOT NULL DEFAULT 'assignee',
  source VARCHAR(60) NOT NULL DEFAULT 'role',
  notified_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_biomed_work_order_recipients_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_biomed_work_order_recipients_staff
  ON biomed_work_order_recipients (tenant_id, work_order_id, staff_id);

CREATE INDEX IF NOT EXISTS idx_biomed_work_order_recipients_staff
  ON biomed_work_order_recipients (tenant_id, staff_id, work_order_id);

ALTER TABLE biomed_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE biomed_work_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE biomed_work_order_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE biomed_work_order_updates FORCE ROW LEVEL SECURITY;
ALTER TABLE biomed_work_order_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE biomed_work_order_recipients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON biomed_work_orders;
CREATE POLICY tenant_isolation ON biomed_work_orders
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

DROP POLICY IF EXISTS tenant_isolation ON biomed_work_order_updates;
CREATE POLICY tenant_isolation ON biomed_work_order_updates
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

DROP POLICY IF EXISTS tenant_isolation ON biomed_work_order_recipients;
CREATE POLICY tenant_isolation ON biomed_work_order_recipients
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
