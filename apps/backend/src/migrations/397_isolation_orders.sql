-- 397_isolation_orders.sql
--
-- N6-6 infection-control depth: isolation orders, precaution checklist
-- rows, command-board source data, and the deferred notifiable-disease flag.

BEGIN;

ALTER TABLE diagnoses
  ADD COLUMN IF NOT EXISTS notifiable_disease_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notifiable_disease_marked_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS notifiable_disease_marked_by UUID;

CREATE INDEX IF NOT EXISTS idx_diagnoses_notifiable_tenant
  ON diagnoses (tenant_id, created_at DESC)
  WHERE notifiable_disease_flag = TRUE;

CREATE TABLE IF NOT EXISTS isolation_orders (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  infection_case_id INTEGER,
  precaution_type VARCHAR(30) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  reason TEXT,
  ordered_by UUID NOT NULL,
  ordered_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  discontinued_by UUID,
  discontinued_at TIMESTAMPTZ(6),
  terminal_clean_requested_at TIMESTAMPTZ(6),
  terminal_clean_request_id INTEGER,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT isolation_orders_precaution_check
    CHECK (precaution_type IN ('standard', 'contact', 'droplet', 'airborne', 'protective', 'enteric')),
  CONSTRAINT isolation_orders_status_check
    CHECK (status IN ('active', 'discontinued', 'cancelled')),
  CONSTRAINT fk_isolation_orders_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_isolation_orders_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION,
  CONSTRAINT fk_isolation_orders_admission
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE SET NULL,
  CONSTRAINT fk_isolation_orders_case
    FOREIGN KEY (infection_case_id) REFERENCES infection_cases(id) ON DELETE SET NULL,
  CONSTRAINT fk_isolation_orders_terminal_clean
    FOREIGN KEY (terminal_clean_request_id) REFERENCES housekeeping_requests(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS isolation_order_checklist_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  isolation_order_id BIGINT NOT NULL,
  item_key VARCHAR(80) NOT NULL,
  label TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  completed_by UUID,
  completed_at TIMESTAMPTZ(6),
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT isolation_order_checklist_status_check
    CHECK (status IN ('pending', 'complete', 'not_applicable')),
  CONSTRAINT uq_isolation_order_checklist_item
    UNIQUE (tenant_id, isolation_order_id, item_key),
  CONSTRAINT fk_isolation_order_checklist_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_isolation_order_checklist_order
    FOREIGN KEY (isolation_order_id) REFERENCES isolation_orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_isolation_orders_active_admission
  ON isolation_orders (tenant_id, admission_id, ordered_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_isolation_orders_patient
  ON isolation_orders (tenant_id, patient_uid, ordered_at DESC);

CREATE INDEX IF NOT EXISTS idx_isolation_order_checklist_order
  ON isolation_order_checklist_items (tenant_id, isolation_order_id, status);

ALTER TABLE isolation_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE isolation_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON isolation_orders;
CREATE POLICY tenant_isolation ON isolation_orders
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

ALTER TABLE isolation_order_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE isolation_order_checklist_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON isolation_order_checklist_items;
CREATE POLICY tenant_isolation ON isolation_order_checklist_items
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
