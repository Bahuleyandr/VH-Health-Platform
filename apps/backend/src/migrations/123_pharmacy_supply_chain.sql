-- Migration 123: Phase C4 — pharmacy supply chain.
--
-- HEALTHCARE_AI_SPEC_AUDIT.md §8: medication / clinical-rules side is
-- strong+, but pharmacy supply chain (inventory batches, suppliers,
-- POs, GRN, expiry, substitutes) is missing. clinical_ai_inventory_alerts
-- forecasts demand but there's no inventory_batch table to forecast
-- against; pharmacy_orders are stand-alone with no GRN/PO trail.
--
-- Tables:
--   1. pharmacy_suppliers           — vendor master with GST + bank
--                                       details + payment terms.
--   2. pharmacy_inventory_items     — distinct SKU per (medication,
--                                       form, strength, manufacturer)
--                                       at the facility level.
--   3. pharmacy_inventory_batches   — per-lot stock with expiry +
--                                       received quantity + remaining
--                                       quantity. FEFO consumption.
--   4. pharmacy_purchase_orders     — PO header with supplier + status.
--   5. pharmacy_purchase_order_items— PO line items.
--   6. pharmacy_goods_receipts      — GRN header (receipt against PO
--                                       or against ad-hoc invoice).
--   7. pharmacy_goods_receipt_items — GRN line items linked to batches.
--   8. pharmacy_stock_movements     — append-only ledger of every
--                                       stock change (receive / issue /
--                                       transfer / return / dispose /
--                                       adjustment).
--   9. pharmacy_expiry_alerts       — expiring stock alerts feed.
--  10. pharmacy_substitutes         — manufacturer-allowed substitution
--                                       graph (generic equivalents).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. pharmacy_suppliers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_suppliers (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_code               VARCHAR(80) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  legal_name                  VARCHAR(255),
  gstin                       VARCHAR(40),
  drug_license_number         VARCHAR(120),
  pan                         VARCHAR(20),
  contact_email               VARCHAR(255),
  contact_phone               VARCHAR(40),
  address                     TEXT,
  payment_terms               VARCHAR(60),
  bank_details                JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'blacklisted', 'archived')),
  rating                      NUMERIC(3,2),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, supplier_code)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_suppliers_tenant_status
  ON pharmacy_suppliers (tenant_id, status, display_name);

-- ---------------------------------------------------------------------------
-- 2. pharmacy_inventory_items (SKU master)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_inventory_items (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER,
  sku_code                    VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  generic_name                VARCHAR(255),
  brand_name                  VARCHAR(255),
  manufacturer                VARCHAR(255),
  form                        VARCHAR(80),
  strength                    VARCHAR(80),
  unit_label                  VARCHAR(40) NOT NULL DEFAULT 'each',
  pack_size                   INTEGER,
  hsn_code                    VARCHAR(40),
  schedule_class              VARCHAR(20),
  is_narcotic                 BOOLEAN NOT NULL DEFAULT false,
  is_cold_chain               BOOLEAN NOT NULL DEFAULT false,
  reorder_level               INTEGER,
  reorder_quantity            INTEGER,
  default_supplier_id         INTEGER REFERENCES pharmacy_suppliers(id) ON DELETE SET NULL,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'discontinued', 'archived')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, sku_code)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_items_tenant_status
  ON pharmacy_inventory_items (tenant_id, status, display_name);
CREATE INDEX IF NOT EXISTS idx_pharmacy_items_facility
  ON pharmacy_inventory_items (tenant_id, facility_id, status)
  WHERE facility_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_items_narcotic
  ON pharmacy_inventory_items (tenant_id, is_narcotic, status)
  WHERE is_narcotic = true;

-- ---------------------------------------------------------------------------
-- 3. pharmacy_inventory_batches (per-lot stock)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_inventory_batches (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inventory_item_id           INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id) ON DELETE CASCADE,
  facility_id                 INTEGER,
  batch_number                VARCHAR(120) NOT NULL,
  lot_number                  VARCHAR(120),
  manufacture_date            DATE,
  expiry_date                 DATE NOT NULL,
  received_quantity           NUMERIC(14, 4) NOT NULL,
  remaining_quantity          NUMERIC(14, 4) NOT NULL,
  unit_cost_minor             BIGINT,
  mrp_minor                   BIGINT,
  supplier_id                 INTEGER REFERENCES pharmacy_suppliers(id) ON DELETE SET NULL,
  goods_receipt_id            INTEGER,
  storage_location_id         INTEGER,
  status                      VARCHAR(20) NOT NULL DEFAULT 'in_stock'
    CHECK (status IN ('in_stock', 'reserved', 'depleted', 'expired', 'recalled', 'quarantined', 'disposed')),
  recall_reference            VARCHAR(255),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_batch_remaining CHECK (remaining_quantity >= 0 AND remaining_quantity <= received_quantity),
  UNIQUE (inventory_item_id, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_batches_item_status
  ON pharmacy_inventory_batches (inventory_item_id, status, expiry_date);
CREATE INDEX IF NOT EXISTS idx_pharmacy_batches_tenant_expiry
  ON pharmacy_inventory_batches (tenant_id, expiry_date)
  WHERE status IN ('in_stock', 'reserved');
CREATE INDEX IF NOT EXISTS idx_pharmacy_batches_supplier
  ON pharmacy_inventory_batches (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_batches_recall
  ON pharmacy_inventory_batches (tenant_id, status)
  WHERE status = 'recalled';

-- ---------------------------------------------------------------------------
-- 4. pharmacy_purchase_orders (PO header)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_purchase_orders (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER,
  po_number                   VARCHAR(80) NOT NULL,
  supplier_id                 INTEGER NOT NULL REFERENCES pharmacy_suppliers(id) ON DELETE RESTRICT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'cancelled', 'closed')),
  ordered_at                  TIMESTAMPTZ,
  expected_at                 TIMESTAMPTZ,
  received_at                 TIMESTAMPTZ,
  total_amount_minor          BIGINT,
  currency                    VARCHAR(8) NOT NULL DEFAULT 'INR',
  notes                       TEXT,
  approved_by                 UUID,
  approved_at                 TIMESTAMPTZ,
  cancellation_reason         TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, po_number)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_po_tenant_status
  ON pharmacy_purchase_orders (tenant_id, status, ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_pharmacy_po_supplier
  ON pharmacy_purchase_orders (supplier_id, status, ordered_at DESC);

-- ---------------------------------------------------------------------------
-- 5. pharmacy_purchase_order_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_purchase_order_items (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id           INTEGER NOT NULL REFERENCES pharmacy_purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id           INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id) ON DELETE RESTRICT,
  ordered_quantity            NUMERIC(14, 4) NOT NULL,
  received_quantity           NUMERIC(14, 4) NOT NULL DEFAULT 0,
  unit_price_minor            BIGINT,
  tax_rate_pct                NUMERIC(5,2),
  notes                       TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_po_received_lte_ordered CHECK (received_quantity <= ordered_quantity),
  UNIQUE (purchase_order_id, inventory_item_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_po_items_po
  ON pharmacy_purchase_order_items (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_po_items_item
  ON pharmacy_purchase_order_items (inventory_item_id);

-- ---------------------------------------------------------------------------
-- 6. pharmacy_goods_receipts (GRN header)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_goods_receipts (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER,
  grn_number                  VARCHAR(80) NOT NULL,
  purchase_order_id           INTEGER REFERENCES pharmacy_purchase_orders(id) ON DELETE SET NULL,
  supplier_id                 INTEGER REFERENCES pharmacy_suppliers(id) ON DELETE SET NULL,
  invoice_number              VARCHAR(120),
  invoice_date                DATE,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                      VARCHAR(20) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'qc_pending', 'qc_failed', 'qc_passed', 'partial', 'rejected', 'archived')),
  total_amount_minor          BIGINT,
  notes                       TEXT,
  received_by                 UUID,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, grn_number)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_grn_tenant_status
  ON pharmacy_goods_receipts (tenant_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pharmacy_grn_po
  ON pharmacy_goods_receipts (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_grn_supplier
  ON pharmacy_goods_receipts (supplier_id, received_at DESC) WHERE supplier_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. pharmacy_goods_receipt_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_goods_receipt_items (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  goods_receipt_id            INTEGER NOT NULL REFERENCES pharmacy_goods_receipts(id) ON DELETE CASCADE,
  inventory_item_id           INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id) ON DELETE RESTRICT,
  inventory_batch_id          INTEGER REFERENCES pharmacy_inventory_batches(id) ON DELETE SET NULL,
  purchase_order_item_id      INTEGER REFERENCES pharmacy_purchase_order_items(id) ON DELETE SET NULL,
  received_quantity           NUMERIC(14, 4) NOT NULL,
  unit_cost_minor             BIGINT,
  qc_status                   VARCHAR(20)
    CHECK (qc_status IS NULL OR qc_status IN ('pending', 'passed', 'failed', 'partial')),
  qc_notes                    TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_grn_items_grn
  ON pharmacy_goods_receipt_items (goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_grn_items_batch
  ON pharmacy_goods_receipt_items (inventory_batch_id) WHERE inventory_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_grn_items_item
  ON pharmacy_goods_receipt_items (inventory_item_id);

-- ---------------------------------------------------------------------------
-- 8. pharmacy_stock_movements (append-only ledger)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_stock_movements (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inventory_item_id           INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id) ON DELETE CASCADE,
  inventory_batch_id          INTEGER REFERENCES pharmacy_inventory_batches(id) ON DELETE SET NULL,
  movement_kind               VARCHAR(40) NOT NULL
    CHECK (movement_kind IN (
      'receive', 'issue', 'transfer_out', 'transfer_in', 'return',
      'adjust_increase', 'adjust_decrease', 'dispose', 'expire', 'recall'
    )),
  quantity_delta              NUMERIC(14, 4) NOT NULL,
  reference_type              VARCHAR(60),
  reference_id                VARCHAR(120),
  performed_by                UUID,
  notes                       TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_mvmt_item_time
  ON pharmacy_stock_movements (inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pharmacy_mvmt_batch
  ON pharmacy_stock_movements (inventory_batch_id, created_at DESC)
  WHERE inventory_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_mvmt_tenant_kind
  ON pharmacy_stock_movements (tenant_id, movement_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pharmacy_mvmt_reference
  ON pharmacy_stock_movements (tenant_id, reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9. pharmacy_expiry_alerts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_expiry_alerts (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inventory_batch_id          INTEGER NOT NULL REFERENCES pharmacy_inventory_batches(id) ON DELETE CASCADE,
  inventory_item_id           INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id) ON DELETE CASCADE,
  expiry_date                 DATE NOT NULL,
  days_remaining              INTEGER NOT NULL,
  severity                    VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'returned', 'disposed', 'expired_used', 'cancelled')),
  acknowledged_by             UUID,
  acknowledged_at             TIMESTAMPTZ,
  resolution                  VARCHAR(40),
  resolved_at                 TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expiry_alerts_tenant_status
  ON pharmacy_expiry_alerts (tenant_id, status, expiry_date);
CREATE INDEX IF NOT EXISTS idx_expiry_alerts_batch
  ON pharmacy_expiry_alerts (inventory_batch_id);
CREATE INDEX IF NOT EXISTS idx_expiry_alerts_severity
  ON pharmacy_expiry_alerts (tenant_id, severity, status)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- 10. pharmacy_substitutes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pharmacy_substitutes (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  primary_item_id             INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id) ON DELETE CASCADE,
  substitute_item_id          INTEGER NOT NULL REFERENCES pharmacy_inventory_items(id) ON DELETE CASCADE,
  substitution_kind           VARCHAR(40) NOT NULL DEFAULT 'generic_equivalent'
    CHECK (substitution_kind IN ('generic_equivalent', 'brand_equivalent', 'therapeutic_class', 'manufacturer_alt', 'dose_strength_alt')),
  is_bidirectional            BOOLEAN NOT NULL DEFAULT true,
  notes                       TEXT,
  created_by                  UUID,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_substitute_distinct CHECK (primary_item_id <> substitute_item_id),
  UNIQUE (tenant_id, primary_item_id, substitute_item_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_substitutes_primary
  ON pharmacy_substitutes (primary_item_id, status);
CREATE INDEX IF NOT EXISTS idx_pharmacy_substitutes_substitute
  ON pharmacy_substitutes (substitute_item_id, status);

COMMIT;
