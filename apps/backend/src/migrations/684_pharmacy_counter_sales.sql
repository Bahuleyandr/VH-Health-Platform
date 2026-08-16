-- 684_pharmacy_counter_sales.sql
--
-- Feature wave 7 — walk-in pharmacy point-of-sale (counter sale).
--
-- Gap: the pharmacy handles patient-app orders (pharmacy_orders) and ward
-- indents, but there is no counter-sale flow for a walk-in customer buying
-- OTC/prescription items over the counter. Retail billing exists only
-- abstractly: billing_invoices supports invoice_type='PHARMACY' (no writer),
-- and cash_drawer_sessions (198) reconcile cashier CASH takings.
--
-- Design decision: NEW tables, not a `walk_in` channel on pharmacy_orders.
-- pharmacy_orders is a phone-anchored patient-app DELIVERY workflow whose
-- status state machine (PENDING → CONFIRMED → PREPARING → DISPATCHED →
-- DELIVERED) is now DB-enforced by migration 649's transition-guard trigger,
-- with e_prescriptions + delivery-tracking satellites. A counter sale is
-- instantaneous (sell → pay → hand over), needs anonymous-customer identity,
-- line-level FEFO batch allocation evidence, and a billing-invoice + refund
-- linkage — none of which fit that state machine without either corrupting it
-- or riddling it with walk_in special cases. Three tables:
--
--   pharmacy_counter_sales        — sale header: customer identity (registered
--                                   patient uid OR captured walk-in name/phone),
--                                   prescription reference (required in-service
--                                   for Schedule H/H1/X lines), billing invoice
--                                   linkage, seller, void evidence.
--   pharmacy_counter_sale_lines   — one row per item sold: schedule-class
--                                   snapshot, quantity, unit price, GST.
--   pharmacy_counter_sale_allocations — one row per (line, batch) FEFO
--                                   allocation: batch/expiry snapshot + the
--                                   pharmacy_stock_movements decrement row it
--                                   commits with, and the return movement on
--                                   void. This is the restock ledger a void
--                                   replays exactly.
--
-- Lifecycle (service-enforced; the DB pins the invariants):
--   IN_PROGRESS  header + lines exist; invoice being built via billingV2.
--   COMPLETED    stock decremented + invoice PAID, all in the finalize tx.
--   VOIDED       same-day void: billing refund raised/paid + per-allocation
--                restock movements (controlled items also re-enter
--                pharmacy_schedule_register in the return direction).
--   FAILED       finalize failed after the invoice was issued; the service
--                voids the invoice as compensation and parks the header here.
--                FAILED rows hold no stock and no money.
--
-- Anonymous walk-ins and billing: billing_invoices.patient_uid is NOT NULL by
-- schema, so anonymous sales anchor their invoice on a single per-tenant
-- system user (role 'PHARMACY_WALKIN', not loginable: no phone/password/
-- firebase identity), created on first use by the service. The invoice's
-- patient_name/patient_phone snapshot columns carry the REAL captured customer
-- identity, and this header stays the source of truth for who bought.
--
-- Statutory register: Schedule H/H1/X and narcotic lines dispense through the
-- existing inventoryV2 dispenseControlled()/pharmacy_schedule_register path —
-- this migration adds no parallel controlled-dispense structure.
--
-- RLS follows the referral_facilities (680) / ambulance (683) request-path
-- pattern: permissive tenant_isolation; the service always writes tenant_id
-- explicitly from request context.

BEGIN;

CREATE TABLE IF NOT EXISTS pharmacy_counter_sales (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Customer identity: a registered patient (users.uid) OR an anonymous
  -- walk-in with name (phone optional) captured at the counter. At least one
  -- identity is mandatory.
  patient_uid       UUID REFERENCES users(uid),
  customer_name     VARCHAR(255),
  customer_phone    VARCHAR(20),
  CONSTRAINT chk_pharmacy_counter_sale_identity
    CHECK (patient_uid IS NOT NULL OR customer_name IS NOT NULL),

  -- Prescription reference. Service-enforced REQUIRED (doctor name plus a
  -- reference or upload pointer) when any line is Schedule H/H1/X or narcotic.
  rx_doctor_name    VARCHAR(255),
  rx_reference      VARCHAR(255),
  -- Pointer into the tenant's upload store (e.g. a file-metadata id for a
  -- photographed paper Rx). Deliberately not an FK: upload subsystems vary
  -- and the sale must not block on upload-store retention.
  rx_upload_id      BIGINT,

  status            VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS'
    CONSTRAINT chk_pharmacy_counter_sale_status
      CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'VOIDED', 'FAILED')),

  -- Billing linkage. The invoice is created via billingV2 (invoice_type
  -- 'PHARMACY') after the header exists (invoice items back-reference this
  -- sale via source_ref_type='pharmacy_counter_sale'), so it is nullable in
  -- IN_PROGRESS/FAILED but pinned NOT NULL once the sale completes.
  invoice_id        INTEGER REFERENCES billing_invoices(id),
  CONSTRAINT chk_pharmacy_counter_sale_invoice_when_completed
    CHECK (status NOT IN ('COMPLETED', 'VOIDED') OR invoice_id IS NOT NULL),

  payment_mode      VARCHAR(20)
    CONSTRAINT chk_pharmacy_counter_sale_payment_mode
      CHECK (payment_mode IS NULL OR payment_mode IN
        ('CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET')),
  payment_reference VARCHAR(120),
  -- Cashier-shift stamp for CASH sales so drawer reconciliation
  -- (cash_drawer_sessions close window) covers the POS takings.
  cash_shift        VARCHAR(20),
  total_amount      NUMERIC(12, 2) NOT NULL DEFAULT 0
    CONSTRAINT chk_pharmacy_counter_sale_total_nonneg CHECK (total_amount >= 0),

  sold_by           UUID NOT NULL,
  sold_by_name      VARCHAR(255),
  notes             TEXT,

  -- Void evidence: all-or-nothing with the VOIDED status.
  voided_at         TIMESTAMPTZ,
  voided_by         UUID,
  void_reason       VARCHAR(255),
  void_refund_id    INTEGER REFERENCES billing_refunds(id),
  CONSTRAINT chk_pharmacy_counter_sale_void_evidence
    CHECK ((status = 'VOIDED')
           = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sales_tenant_time
  ON pharmacy_counter_sales (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sales_tenant_status
  ON pharmacy_counter_sales (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sales_invoice
  ON pharmacy_counter_sales (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sales_patient
  ON pharmacy_counter_sales (patient_uid) WHERE patient_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS pharmacy_counter_sale_lines (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  counter_sale_id    BIGINT NOT NULL
    REFERENCES pharmacy_counter_sales(id) ON DELETE CASCADE,
  inventory_item_id  INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id),
  -- Sale-time snapshots: the drug master row can be renamed/reclassified
  -- later; the sold line keeps what the customer was sold, under what
  -- schedule discipline, at what price.
  item_name          VARCHAR(255) NOT NULL,
  schedule_class     VARCHAR(20),
  is_narcotic        BOOLEAN NOT NULL DEFAULT FALSE,
  quantity           NUMERIC(14, 4) NOT NULL
    CONSTRAINT chk_pharmacy_counter_sale_line_qty CHECK (quantity > 0),
  unit_price         NUMERIC(12, 2) NOT NULL
    CONSTRAINT chk_pharmacy_counter_sale_line_price CHECK (unit_price >= 0),
  gst_rate           NUMERIC(5, 2) NOT NULL DEFAULT 0
    CONSTRAINT chk_pharmacy_counter_sale_line_gst
      CHECK (gst_rate >= 0 AND gst_rate <= 100),
  line_total         NUMERIC(12, 2) NOT NULL DEFAULT 0
    CONSTRAINT chk_pharmacy_counter_sale_line_total CHECK (line_total >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sale_lines_sale
  ON pharmacy_counter_sale_lines (counter_sale_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sale_lines_item
  ON pharmacy_counter_sale_lines (tenant_id, inventory_item_id);

CREATE TABLE IF NOT EXISTS pharmacy_counter_sale_allocations (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  counter_sale_line_id  BIGINT NOT NULL
    REFERENCES pharmacy_counter_sale_lines(id) ON DELETE CASCADE,
  inventory_batch_id    INTEGER NOT NULL REFERENCES pharmacy_inventory_batches(id),
  -- Batch lineage snapshot shown on the receipt and replayed on restock.
  batch_number          VARCHAR(120) NOT NULL,
  expiry_date           DATE NOT NULL,
  quantity              NUMERIC(14, 4) NOT NULL
    CONSTRAINT chk_pharmacy_counter_sale_alloc_qty CHECK (quantity > 0),
  unit_price            NUMERIC(12, 2) NOT NULL
    CONSTRAINT chk_pharmacy_counter_sale_alloc_price CHECK (unit_price >= 0),
  -- The stock-movement decrement this allocation committed with ('issue',
  -- negative delta) and, after a void, the restock movement ('return',
  -- positive delta). Batch decrement without its allocation row (or vice
  -- versa) is impossible: both are written in the same finalize transaction.
  movement_id           INTEGER NOT NULL REFERENCES pharmacy_stock_movements(id),
  return_movement_id    INTEGER REFERENCES pharmacy_stock_movements(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sale_allocations_line
  ON pharmacy_counter_sale_allocations (counter_sale_line_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_counter_sale_allocations_batch
  ON pharmacy_counter_sale_allocations (inventory_batch_id);

-- RLS: permissive tenant_isolation (request-path pattern; service writes
-- tenant_id explicitly).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pharmacy_counter_sales',
    'pharmacy_counter_sale_lines',
    'pharmacy_counter_sale_allocations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $p$, t);
  END LOOP;
END $$;

COMMENT ON TABLE pharmacy_counter_sales IS
  'Walk-in pharmacy point-of-sale header. Customer is a registered patient (patient_uid) or an anonymous walk-in (captured name/phone). Invoice is billingV2 invoice_type=PHARMACY; anonymous sales anchor it on the per-tenant PHARMACY_WALKIN system user while the invoice name/phone snapshot carries the real customer. Schedule H/H1/X lines require the rx_* prescription reference (service-enforced) and dispense through the statutory pharmacy_schedule_register path.';
COMMENT ON COLUMN pharmacy_counter_sales.status IS
  'IN_PROGRESS (header exists, invoice being built) -> COMPLETED (stock decremented + invoice paid atomically) | FAILED (finalize failed; invoice compensated to VOID; holds no stock or money). COMPLETED -> VOIDED via same-day void (refund + per-allocation restock).';
COMMENT ON TABLE pharmacy_counter_sale_allocations IS
  'Per (line, batch) FEFO allocation evidence: batch/expiry snapshot, the issue stock-movement it committed with, and the return movement written when the sale is voided.';

COMMIT;
