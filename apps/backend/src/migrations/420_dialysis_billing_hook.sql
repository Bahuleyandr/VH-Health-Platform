-- 420_dialysis_billing_hook.sql
-- NL6-09: tenant-scoped dialysis billing hook. It is disabled by default and
-- can emit draft invoice lines only after a finance-reviewed tariff is stored.

CREATE TABLE IF NOT EXISTS dialysis_billing_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  charge_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  service_code VARCHAR(50) NOT NULL DEFAULT 'DIALYSIS-HD-SESSION',
  unit_price NUMERIC(12,2),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  finance_reviewed_at TIMESTAMPTZ(6),
  finance_reviewed_by UUID,
  acceptance_snapshot JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_dialysis_billing_settings_price
    CHECK (unit_price IS NULL OR unit_price >= 0),
  CONSTRAINT chk_dialysis_billing_settings_gst
    CHECK (gst_rate >= 0 AND gst_rate <= 28),
  CONSTRAINT chk_dialysis_billing_settings_review_gate
    CHECK (
      charge_enabled = FALSE
      OR (
        finance_reviewed_at IS NOT NULL
        AND unit_price IS NOT NULL
      )
    )
);

INSERT INTO billing_service_master
  (code, description, category, default_price, gst_rate, hsn_sac)
SELECT
  'DIALYSIS-HD-SESSION',
  'Dialysis session - finance reviewed tariff pending',
  'procedure',
  0.00,
  0.00,
  '9993'
WHERE NOT EXISTS (
  SELECT 1 FROM billing_service_master WHERE code = 'DIALYSIS-HD-SESSION'
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoice_items_dialysis_session
  ON billing_invoice_items (source_ref_type, source_ref_id)
  WHERE source_ref_type = 'dialysis_session' AND source_ref_id IS NOT NULL;

ALTER TABLE dialysis_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dialysis_billing_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON dialysis_billing_settings;
CREATE POLICY tenant_isolation ON dialysis_billing_settings
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
