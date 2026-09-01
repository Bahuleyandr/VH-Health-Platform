-- NL-13 P1d: owner-controlled cath billing hook. Disabled by default; the
-- clinical usage record remains authoritative even when billing is disabled,
-- incomplete, or unavailable.

CREATE TABLE IF NOT EXISTS cath_consumables_billing_settings (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  charge_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  procedure_billing_code VARCHAR(50),
  procedure_unit_price NUMERIC(12,2),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  finance_reviewed_at TIMESTAMPTZ(6),
  finance_reviewed_by UUID,
  acceptance_snapshot JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT cath_consumables_billing_settings_pkey PRIMARY KEY (tenant_id),
  CONSTRAINT cath_consumables_billing_price_check
    CHECK (procedure_unit_price IS NULL OR procedure_unit_price >= 0),
  CONSTRAINT cath_consumables_billing_gst_check
    CHECK (gst_rate >= 0 AND gst_rate <= 28),
  CONSTRAINT cath_consumables_billing_review_gate_check
    CHECK (NOT charge_enabled OR finance_reviewed_at IS NOT NULL),
  CONSTRAINT cath_consumables_billing_procedure_mapping_check
    CHECK (
      (procedure_billing_code IS NULL AND procedure_unit_price IS NULL)
      OR (procedure_billing_code IS NOT NULL AND procedure_unit_price IS NOT NULL)
    )
);

ALTER TABLE billing_invoice_items
  ALTER COLUMN source_ref_id TYPE BIGINT
  USING source_ref_id::bigint;

ALTER TABLE billing_invoice_items
  ADD COLUMN IF NOT EXISTS source_ref_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Older billing writers relied on the RLS GUC/default for the child tenant.
-- Re-anchor every historical line to its authoritative parent invoice before
-- tenant-scoped source uniqueness is enforced.
UPDATE billing_invoice_items AS item
   SET tenant_id = invoice.tenant_id
  FROM billing_invoices AS invoice
 WHERE invoice.id = item.invoice_id
   AND item.tenant_id IS DISTINCT FROM invoice.tenant_id;

UPDATE billing_invoice_items AS item
   SET source_ref_active = NOT (
     invoice.status = 'VOID'
     AND invoice.issued_at IS NULL
   )
  FROM billing_invoices AS invoice
 WHERE invoice.id = item.invoice_id
   AND item.source_ref_active IS DISTINCT FROM NOT (
     invoice.status = 'VOID'
     AND invoice.issued_at IS NULL
   );

DROP INDEX IF EXISTS ux_billing_invoice_items_dialysis_session;
CREATE UNIQUE INDEX ux_billing_invoice_items_dialysis_session
  ON billing_invoice_items (tenant_id, source_ref_type, source_ref_id)
  WHERE source_ref_type = 'dialysis_session'
    AND source_ref_id IS NOT NULL
    AND source_ref_active;

DROP INDEX IF EXISTS ux_billing_invoice_items_cath_procedure;
CREATE UNIQUE INDEX ux_billing_invoice_items_cath_procedure
  ON billing_invoice_items (tenant_id, source_ref_type, source_ref_id)
  WHERE source_ref_type = 'cath_procedure_log'
    AND source_ref_id IS NOT NULL
    AND source_ref_active;

DROP INDEX IF EXISTS ux_billing_invoice_items_cath_consumable;
CREATE UNIQUE INDEX ux_billing_invoice_items_cath_consumable
  ON billing_invoice_items (tenant_id, source_ref_type, source_ref_id)
  WHERE source_ref_type = 'cath_consumable_usage'
    AND source_ref_id IS NOT NULL
    AND source_ref_active;

ALTER TABLE cath_consumables_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_consumables_billing_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_consumables_billing_settings;
CREATE POLICY tenant_isolation ON cath_consumables_billing_settings
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
