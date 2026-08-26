-- 738_gst_einvoice_documents.sql
--
-- GST e-invoicing (IRN / IRP) document store (G2, reaudit 2026-08-25).
--
-- The billing engine already computes cgst/sgst/igst per invoice
-- (billing_invoices, migration 149). A 100-200-bed hospital is above the
-- e-invoice threshold and its B2B (TPA/corporate/insurer) invoices legally
-- require an IRN (Invoice Reference Number) obtained from the Invoice
-- Registration Portal (IRP) via a GSP. This table is the evidence store for
-- that leg: one row per invoice's IRN request/ack/status, written behind a
-- swappable GSP adapter whose default provider is a self-contained SANDBOX/MOCK
-- (no external credentials — tests and the dark default use it).
--
-- The Tally/GL accounting export (G2 part a) is a pure read projection of
-- billing_invoices and needs NO storage — it is not represented here.
--
-- RLS follows the mis_report_schedules (migration 679) request-path pattern:
-- permissive tenant_isolation, ENABLE + FORCE, service writers supply tenant_id
-- explicitly (dev/QA/CI keep the GUC unset — first OR branch keeps them open).

BEGIN;

CREATE TABLE IF NOT EXISTS gst_einvoice_documents (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id          INTEGER NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,

  -- Swappable GSP adapter identity. 'mock'/'sandbox' are self-contained (no
  -- creds); 'nic'/'gsp' are the live seams (owner-side credentials required).
  provider            VARCHAR(20) NOT NULL DEFAULT 'mock'
    CHECK (provider IN ('mock', 'sandbox', 'nic', 'gsp')),
  seller_gstin        VARCHAR(20),

  -- IRP response evidence. IRN is the 64-char hash the IRP returns.
  irn                 VARCHAR(64),
  ack_no              VARCHAR(40),
  ack_date            TIMESTAMPTZ,
  signed_invoice      TEXT,            -- signed invoice JWT/JSON returned by the IRP
  signed_qr_code      TEXT,            -- signed QR payload (base64) for print

  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'failed', 'cancelled')),

  request_payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code          VARCHAR(40),
  error_message       TEXT,

  -- Cancellation (IRP allows IRN cancellation within 24h).
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       VARCHAR(255),
  cancelled_by        UUID,

  generated_at        TIMESTAMPTZ,
  created_by          UUID,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One live (non-cancelled) e-invoice document per invoice.
  CONSTRAINT chk_gst_einvoice_generated_has_irn CHECK (
    status <> 'generated' OR irn IS NOT NULL
  ),
  CONSTRAINT chk_gst_einvoice_cancelled_has_reason CHECK (
    status <> 'cancelled' OR cancel_reason IS NOT NULL
  )
);

-- One active document per invoice (cancelled rows do not block a re-generation).
CREATE UNIQUE INDEX IF NOT EXISTS ux_gst_einvoice_invoice_live
  ON gst_einvoice_documents (tenant_id, invoice_id)
  WHERE status <> 'cancelled';
-- IRN is globally unique when present.
CREATE UNIQUE INDEX IF NOT EXISTS ux_gst_einvoice_irn
  ON gst_einvoice_documents (irn)
  WHERE irn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gst_einvoice_status
  ON gst_einvoice_documents (tenant_id, status, created_at DESC);

ALTER TABLE gst_einvoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_einvoice_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON gst_einvoice_documents;
CREATE POLICY tenant_isolation ON gst_einvoice_documents
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

COMMENT ON TABLE gst_einvoice_documents IS
  'GST e-invoice (IRN/IRP) evidence store — one row per invoice IRN request/ack/status, written behind a swappable GSP adapter (default self-contained mock/sandbox).';

COMMIT;
