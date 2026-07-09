-- N6-14: linen/laundry par stock foundation.
-- Tenant-scoped linen item catalog plus per-ward par and actual counts.

BEGIN;

CREATE TABLE IF NOT EXISTS linen_item_types (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  item_code VARCHAR(80) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT 'bed_linen',
  unit VARCHAR(30) NOT NULL DEFAULT 'piece',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_linen_item_types_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT linen_item_types_category_check
    CHECK (category IN ('bed_linen', 'patient_linen', 'staff_linen', 'ot_linen', 'housekeeping', 'other')),
  CONSTRAINT linen_item_types_code_check
    CHECK (length(trim(item_code)) > 0),
  CONSTRAINT linen_item_types_display_name_check
    CHECK (length(trim(display_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_linen_item_types_tenant_code
  ON linen_item_types (tenant_id, item_code);

CREATE INDEX IF NOT EXISTS idx_linen_item_types_tenant_active
  ON linen_item_types (tenant_id, active, display_name);

CREATE TABLE IF NOT EXISTS linen_ward_par_levels (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  ward_name VARCHAR(120) NOT NULL,
  item_type_id BIGINT NOT NULL REFERENCES linen_item_types(id) ON DELETE RESTRICT,
  par_quantity INTEGER NOT NULL DEFAULT 0,
  actual_quantity INTEGER NOT NULL DEFAULT 0,
  reorder_threshold INTEGER NOT NULL DEFAULT 0,
  last_counted_at TIMESTAMPTZ,
  last_cycle_id BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_linen_ward_par_levels_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT linen_ward_par_levels_non_negative_check
    CHECK (par_quantity >= 0 AND actual_quantity >= 0 AND reorder_threshold >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_linen_ward_par_levels_tenant_ward_item
  ON linen_ward_par_levels (tenant_id, ward_id, item_type_id);

CREATE INDEX IF NOT EXISTS idx_linen_ward_par_levels_tenant_ward
  ON linen_ward_par_levels (tenant_id, ward_id, active);

CREATE INDEX IF NOT EXISTS idx_linen_ward_par_levels_below_par
  ON linen_ward_par_levels (tenant_id, active, ward_id)
  WHERE actual_quantity < par_quantity;

ALTER TABLE linen_item_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE linen_item_types FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON linen_item_types;
CREATE POLICY tenant_isolation ON linen_item_types
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

ALTER TABLE linen_ward_par_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE linen_ward_par_levels FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON linen_ward_par_levels;
CREATE POLICY tenant_isolation ON linen_ward_par_levels
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
