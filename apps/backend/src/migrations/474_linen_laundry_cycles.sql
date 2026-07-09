-- N6-14: linen/laundry collection, wash, return, and reconciliation counts.

BEGIN;

CREATE TABLE IF NOT EXISTS linen_laundry_cycles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  cycle_code VARCHAR(80) NOT NULL,
  ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  ward_name VARCHAR(120) NOT NULL,
  housekeeping_request_id INTEGER REFERENCES housekeeping_requests(id) ON DELETE SET NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'collection_requested',
  discrepancy_flag BOOLEAN NOT NULL DEFAULT FALSE,
  requested_by UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collected_by UUID,
  collected_at TIMESTAMPTZ,
  sent_to_laundry_by UUID,
  sent_to_laundry_at TIMESTAMPTZ,
  returned_by UUID,
  returned_at TIMESTAMPTZ,
  reconciled_by UUID,
  reconciled_at TIMESTAMPTZ,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_linen_laundry_cycles_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT linen_laundry_cycles_status_check
    CHECK (status IN ('collection_requested', 'collected', 'in_laundry', 'returned', 'reconciled', 'cancelled')),
  CONSTRAINT linen_laundry_cycles_code_check
    CHECK (length(trim(cycle_code)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_linen_laundry_cycles_tenant_code
  ON linen_laundry_cycles (tenant_id, cycle_code);

CREATE INDEX IF NOT EXISTS idx_linen_laundry_cycles_tenant_ward_status
  ON linen_laundry_cycles (tenant_id, ward_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_linen_laundry_cycles_discrepancy
  ON linen_laundry_cycles (tenant_id, discrepancy_flag, updated_at DESC)
  WHERE discrepancy_flag = TRUE;

CREATE TABLE IF NOT EXISTS linen_laundry_cycle_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  cycle_id BIGINT NOT NULL REFERENCES linen_laundry_cycles(id) ON DELETE CASCADE,
  item_type_id BIGINT NOT NULL REFERENCES linen_item_types(id) ON DELETE RESTRICT,
  soiled_planned_quantity INTEGER NOT NULL DEFAULT 0,
  soiled_collected_quantity INTEGER NOT NULL DEFAULT 0,
  clean_returned_quantity INTEGER NOT NULL DEFAULT 0,
  damaged_quantity INTEGER NOT NULL DEFAULT 0,
  missing_quantity INTEGER NOT NULL DEFAULT 0,
  discrepancy_quantity INTEGER NOT NULL DEFAULT 0,
  discrepancy_flag BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_linen_laundry_cycle_items_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT linen_laundry_cycle_items_non_negative_check
    CHECK (
      soiled_planned_quantity >= 0
      AND soiled_collected_quantity >= 0
      AND clean_returned_quantity >= 0
      AND damaged_quantity >= 0
      AND missing_quantity >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_linen_laundry_cycle_items_cycle_item
  ON linen_laundry_cycle_items (cycle_id, item_type_id);

CREATE INDEX IF NOT EXISTS idx_linen_laundry_cycle_items_tenant_item
  ON linen_laundry_cycle_items (tenant_id, item_type_id, updated_at DESC);

ALTER TABLE linen_ward_par_levels
  ADD CONSTRAINT fk_linen_ward_par_levels_last_cycle
  FOREIGN KEY (last_cycle_id) REFERENCES linen_laundry_cycles(id) ON DELETE SET NULL;

ALTER TABLE linen_laundry_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE linen_laundry_cycles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON linen_laundry_cycles;
CREATE POLICY tenant_isolation ON linen_laundry_cycles
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

ALTER TABLE linen_laundry_cycle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE linen_laundry_cycle_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON linen_laundry_cycle_items;
CREATE POLICY tenant_isolation ON linen_laundry_cycle_items
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
