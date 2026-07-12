-- NL-13 P1d: per-case cath consumable usage, batch/expiry evidence, and
-- fail-visible inventory/billing state.

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_lab_cases_usage_tenant_patient
  ON cath_lab_cases (tenant_id, id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_procedure_logs_usage_tenant_case_patient
  ON cath_procedure_logs (tenant_id, id, case_id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_inventory_batches_tenant_id_for_cath
  ON pharmacy_inventory_batches (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_tenant_id_for_cath
  ON pharmacy_stock_movements (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_timeline_events_tenant_id_for_cath
  ON clinical_timeline_events (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_audit_events_tenant_id_for_cath
  ON clinical_audit_events (tenant_id, id);

CREATE TABLE IF NOT EXISTS cath_case_consumable_usage (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  procedure_log_id BIGINT REFERENCES cath_procedure_logs(id) ON DELETE SET NULL,
  catalog_item_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  inventory_batch_id INTEGER REFERENCES pharmacy_inventory_batches(id) ON DELETE SET NULL,
  quantity NUMERIC(14,4) NOT NULL,
  batch_tracked BOOLEAN NOT NULL,
  is_implant BOOLEAN NOT NULL,
  batch_number VARCHAR(120),
  lot_number VARCHAR(120),
  expiry_date DATE,
  serial_number VARCHAR(160),
  unit_cost_snapshot NUMERIC(12,2),
  used_by UUID,
  used_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  wasted BOOLEAN NOT NULL DEFAULT FALSE,
  waste_reason TEXT,
  inventory_decrement_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  inventory_movement_id INTEGER REFERENCES pharmacy_stock_movements(id) ON DELETE SET NULL,
  inventory_warning TEXT,
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(200),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_cath_consumable_usage_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_consumable_usage_case_tenant_patient
    FOREIGN KEY (tenant_id, case_id, patient_uid)
    REFERENCES cath_lab_cases (tenant_id, id, patient_uid) ON DELETE CASCADE,
  CONSTRAINT fk_cath_consumable_usage_procedure_tenant_case_patient
    FOREIGN KEY (tenant_id, procedure_log_id, case_id, patient_uid)
    REFERENCES cath_procedure_logs (tenant_id, id, case_id, patient_uid) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_consumable_usage_catalog_snapshot
    FOREIGN KEY (tenant_id, catalog_item_id, batch_tracked, is_implant)
    REFERENCES cath_consumable_catalog (tenant_id, id, batch_tracked, is_implant)
    ON DELETE RESTRICT,
  CONSTRAINT fk_cath_consumable_usage_inventory_batch_tenant
    FOREIGN KEY (tenant_id, inventory_batch_id)
    REFERENCES pharmacy_inventory_batches (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_consumable_usage_inventory_movement_tenant
    FOREIGN KEY (tenant_id, inventory_movement_id)
    REFERENCES pharmacy_stock_movements (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_consumable_usage_timeline_tenant
    FOREIGN KEY (tenant_id, timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_consumable_usage_audit_tenant
    FOREIGN KEY (tenant_id, audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT cath_consumable_usage_quantity_check
    CHECK (quantity > 0),
  CONSTRAINT cath_consumable_usage_cost_check
    CHECK (unit_cost_snapshot IS NULL OR unit_cost_snapshot >= 0),
  CONSTRAINT cath_consumable_usage_batch_expiry_check
    CHECK (
      NOT batch_tracked
      OR (
        COALESCE(NULLIF(BTRIM(batch_number), ''), NULLIF(BTRIM(lot_number), '')) IS NOT NULL
        AND expiry_date IS NOT NULL
      )
    ),
  CONSTRAINT cath_consumable_usage_implant_serial_check
    CHECK (NOT is_implant OR NULLIF(BTRIM(serial_number), '') IS NOT NULL),
  CONSTRAINT cath_consumable_usage_waste_reason_check
    CHECK (NOT wasted OR NULLIF(BTRIM(waste_reason), '') IS NOT NULL),
  CONSTRAINT cath_consumable_usage_inventory_status_check
    CHECK (inventory_decrement_status IN (
      'pending', 'not_linked', 'decremented', 'insufficient_stock', 'error'
    ))
);

CREATE INDEX IF NOT EXISTS idx_cath_consumable_usage_case
  ON cath_case_consumable_usage (tenant_id, case_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_consumable_usage_procedure
  ON cath_case_consumable_usage (tenant_id, procedure_log_id)
  WHERE procedure_log_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cath_consumable_usage_patient_implants
  ON cath_case_consumable_usage (tenant_id, patient_uid, used_at DESC)
  WHERE is_implant;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_consumable_usage_implant_serial
  ON cath_case_consumable_usage (tenant_id, serial_number)
  WHERE is_implant AND serial_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cath_consumable_usage_catalog
  ON cath_case_consumable_usage (tenant_id, catalog_item_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_consumable_usage_inventory_followup
  ON cath_case_consumable_usage (tenant_id, inventory_decrement_status, used_at)
  WHERE inventory_decrement_status IN ('pending', 'insufficient_stock', 'error');

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_consumable_usage_tenant_origin
  ON cath_case_consumable_usage (tenant_id, id, case_id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_consumable_usage_idempotency
  ON cath_case_consumable_usage (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE cath_case_consumable_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_case_consumable_usage FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_case_consumable_usage;
CREATE POLICY tenant_isolation ON cath_case_consumable_usage
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
