-- NL-13 P1d: tenant-scoped cath consumable and implant catalog.

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_inventory_items_tenant_id_for_cath
  ON pharmacy_inventory_items (tenant_id, id);

CREATE TABLE IF NOT EXISTS cath_consumable_catalog (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  inventory_item_id INTEGER REFERENCES pharmacy_inventory_items(id) ON DELETE SET NULL,
  item_name VARCHAR(255) NOT NULL,
  category VARCHAR(40) NOT NULL DEFAULT 'other',
  manufacturer VARCHAR(255),
  model VARCHAR(160),
  is_implant BOOLEAN NOT NULL DEFAULT FALSE,
  batch_tracked BOOLEAN NOT NULL DEFAULT FALSE,
  default_unit_cost_reference NUMERIC(12,2),
  billing_item_code VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  retired_at TIMESTAMPTZ(6),
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_cath_consumable_catalog_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_consumable_catalog_inventory_tenant
    FOREIGN KEY (tenant_id, inventory_item_id)
    REFERENCES pharmacy_inventory_items (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT cath_consumable_catalog_category_check
    CHECK (category IN (
      'stent', 'balloon', 'guidewire', 'catheter', 'sheath',
      'closure_device', 'pacemaker', 'lead', 'other'
    )),
  CONSTRAINT cath_consumable_catalog_cost_check
    CHECK (default_unit_cost_reference IS NULL OR default_unit_cost_reference >= 0),
  CONSTRAINT cath_consumable_catalog_status_check
    CHECK (status IN ('active', 'retired')),
  CONSTRAINT cath_consumable_catalog_retired_check
    CHECK (
      (status = 'active' AND retired_at IS NULL)
      OR (status = 'retired' AND retired_at IS NOT NULL)
    ),
  CONSTRAINT cath_consumable_catalog_stent_batch_check
    CHECK (category <> 'stent' OR batch_tracked),
  CONSTRAINT cath_consumable_catalog_implant_batch_check
    CHECK (NOT is_implant OR batch_tracked),
  CONSTRAINT cath_consumable_catalog_category_implant_check
    CHECK (category NOT IN ('stent', 'pacemaker', 'lead') OR is_implant)
);

CREATE INDEX IF NOT EXISTS idx_cath_consumable_catalog_active
  ON cath_consumable_catalog (tenant_id, status, category, item_name);

CREATE INDEX IF NOT EXISTS idx_cath_consumable_catalog_inventory_item
  ON cath_consumable_catalog (tenant_id, inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cath_consumable_catalog_billing_mapping
  ON cath_consumable_catalog (tenant_id, billing_item_code)
  WHERE billing_item_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_consumable_catalog_usage_snapshot
  ON cath_consumable_catalog (tenant_id, id, batch_tracked, is_implant);

ALTER TABLE cath_consumable_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_consumable_catalog FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_consumable_catalog;
CREATE POLICY tenant_isolation ON cath_consumable_catalog
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
