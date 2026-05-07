-- Migration 149: Billing core (Sprint 1).
--
-- Closes the orphan `invoices` table the existing billingService.js
-- queried (same pattern fixed earlier for data_breaches, staff_messages,
-- staff_shifts, replacement_requests). Adds the line-item + GST +
-- advance + refund + service-master surface needed for an Indian
-- hospital deployment.
--
-- Indian GST notes:
--   * Most healthcare services are EXEMPT under SAC 9993 (Healthcare
--     Services rendered by clinical establishment). gst_rate defaults
--     to 0 on service_master rows.
--   * Pharmacy retail supply, AMC for medical equipment, room rent
--     above ₹5,000/day non-ICU, ambulance for non-clinical purposes,
--     and hire of equipment to non-establishments are TAXABLE — the
--     hospital's accountant should set those rows' rate explicitly.
--   * GST is split CGST + SGST when intra-state, IGST when inter-state.
--     The split is decided at invoice time based on the patient's
--     state vs hospital's state. We store it explicitly per item.
--   * Tax on tax: never. Inclusive vs exclusive: we store unit_price
--     ex-GST and compute tax on top.
--
-- All CREATE statements use IF NOT EXISTS so the migration is idempotent
-- across environments that may have hand-rolled some of these tables.

BEGIN;

-- ── Service master ────────────────────────────────────────────────────
-- One row per billable item the hospital sells. Used as the autocomplete
-- source on the new-invoice screen + as the default GST rate for a line.
CREATE TABLE IF NOT EXISTS billing_service_master (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(50) UNIQUE NOT NULL,
  description     VARCHAR(255) NOT NULL,
  category        VARCHAR(50) NOT NULL,         -- consultation/room/ot/lab/pharmacy/package/consumable/other
  default_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,    -- e.g. 0, 5, 12, 18
  hsn_sac         VARCHAR(20),                  -- HSN/SAC code; hospital accountant fills
  is_active       BOOLEAN NOT NULL DEFAULT true,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_master_category
  ON billing_service_master(category) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_service_master_tenant
  ON billing_service_master(tenant_id);

-- Seed a small starter catalogue so the new-invoice screen has something
-- to suggest on day one. Hospital accountant can edit / replace these.
-- gst_rate = 0 since clinical establishment services are exempt.
INSERT INTO billing_service_master (code, description, category, default_price, gst_rate, hsn_sac)
SELECT * FROM (VALUES
  ('CONS-OP-GEN'::VARCHAR(50),  'OP consultation - General'::VARCHAR(255),  'consultation'::VARCHAR(50),  500.00,  0::NUMERIC, '9993'::VARCHAR(20)),
  ('CONS-OP-SPEC',              'OP consultation - Specialist',             'consultation',                800.00,  0,           '9993'),
  ('CONS-IP-VIS',               'IP visit charge',                          'consultation',                700.00,  0,           '9993'),
  ('ROOM-GEN',                  'Room charge - General ward (per day)',     'room',                       1500.00,  0,           '9993'),
  ('ROOM-PVT',                  'Room charge - Private (per day)',          'room',                       3500.00,  0,           '9993'),
  ('ROOM-ICU',                  'Room charge - ICU (per day)',              'room',                       6000.00,  0,           '9993'),
  ('OT-MINOR',                  'OT charges - Minor procedure',             'ot',                         3000.00,  0,           '9993'),
  ('OT-MAJOR',                  'OT charges - Major procedure',             'ot',                        15000.00,  0,           '9993'),
  ('LAB-CBC',                   'Complete Blood Count',                     'lab',                         300.00,  0,           '9993'),
  ('LAB-RFT',                   'Renal Function Test',                      'lab',                         800.00,  0,           '9993'),
  ('LAB-LFT',                   'Liver Function Test',                      'lab',                         900.00,  0,           '9993'),
  ('LAB-ECG',                   'ECG',                                      'lab',                         200.00,  0,           '9993'),
  ('NURSING-DAY',               'Nursing charge (per day)',                 'consultation',                500.00,  0,           '9993'),
  ('CONSUM-GENERIC',            'Consumables - generic bundle',             'consumable',                  100.00,  12,          '3005')
) AS seed(code, description, category, default_price, gst_rate, hsn_sac)
WHERE NOT EXISTS (SELECT 1 FROM billing_service_master);

-- ── Invoice header ────────────────────────────────────────────────────
-- One row per bill the hospital raises. Status walks DRAFT → ISSUED →
-- (PARTIAL → ) PAID, plus VOID terminal. Items + payments are children.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id                SERIAL PRIMARY KEY,
  invoice_number    VARCHAR(50) UNIQUE,                     -- e.g. INV-2026-000123; assigned at issue time
  patient_uid       UUID NOT NULL,
  patient_phone     VARCHAR(15),                            -- snapshot at billing time
  patient_name      VARCHAR(255),                           -- snapshot at billing time
  admission_id      INTEGER,                                -- nullable; OP bills aren't tied to an admission
  doctor_uid        UUID,                                   -- attending / consulting doctor at time of bill
  department        VARCHAR(100),
  invoice_type      VARCHAR(50) NOT NULL DEFAULT 'OP',      -- OP / IP / PHARMACY / EMERGENCY
  patient_state     VARCHAR(50),                            -- determines IGST vs CGST+SGST split
  hospital_state    VARCHAR(50),
  subtotal          NUMERIC(12,2) NOT NULL DEFAULT 0,       -- ex-GST sum of all items
  cgst_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  igst_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_reason   VARCHAR(255),
  discount_approved_by UUID,
  total_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,       -- subtotal + taxes - discount
  amount_paid       NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_due        NUMERIC(12,2) NOT NULL DEFAULT 0,       -- total_amount - amount_paid
  status            VARCHAR(20) NOT NULL DEFAULT 'DRAFT',   -- DRAFT/ISSUED/PARTIAL/PAID/VOID
  notes             TEXT,
  created_by        UUID,
  issued_at         TIMESTAMPTZ,
  voided_at         TIMESTAMPTZ,
  voided_by         UUID,
  void_reason       VARCHAR(255),
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_patient ON billing_invoices(patient_uid);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON billing_invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_admission ON billing_invoices(admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_issued_at ON billing_invoices(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON billing_invoices(tenant_id);

-- Numbering counter — kept here rather than relying on SERIAL so we get
-- "INV-YYYY-NNNNNN" with reset per fiscal year. Single row per tenant.
CREATE TABLE IF NOT EXISTS billing_invoice_counter (
  tenant_id     UUID NOT NULL,
  fiscal_year   INTEGER NOT NULL,                           -- e.g. 2026 (Apr-Mar)
  next_value    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, fiscal_year)
);

-- ── Invoice items (line items) ────────────────────────────────────────
-- One row per billable line on an invoice. unit_price is ex-GST.
-- gst_rate is the rate applied to THIS line (snapshotted from the
-- service_master at issue time so changes to the master don't rewrite
-- history).
CREATE TABLE IF NOT EXISTS billing_invoice_items (
  id              SERIAL PRIMARY KEY,
  invoice_id      INTEGER NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  service_code    VARCHAR(50),                              -- nullable for ad-hoc lines
  description     VARCHAR(255) NOT NULL,
  category        VARCHAR(50),
  hsn_sac         VARCHAR(20),
  quantity        NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(12,2) NOT NULL,                   -- ex-GST
  gst_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_subtotal   NUMERIC(12,2) NOT NULL,                   -- quantity * unit_price
  cgst_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  igst_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total      NUMERIC(12,2) NOT NULL,                   -- subtotal + this line's GST
  notes           VARCHAR(255),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
  ON billing_invoice_items(invoice_id);

-- ── Payments ──────────────────────────────────────────────────────────
-- One row per actual collection (full or partial) against an invoice.
-- Mode tells UI / accounts which book to post to. denominations is a
-- JSONB capture for cash mode (₹500x10 + ₹100x5 etc.) so the cashier's
-- end-of-shift reconciliation has source-of-truth detail.
CREATE TABLE IF NOT EXISTS billing_payments (
  id              SERIAL PRIMARY KEY,
  invoice_id      INTEGER REFERENCES billing_invoices(id) ON DELETE SET NULL,
  patient_uid     UUID NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  mode            VARCHAR(20) NOT NULL,                     -- CASH/CARD/UPI/NETBANKING/CHEQUE/DD/WALLET/INSURANCE
  reference       VARCHAR(255),                             -- txn id / cheque no / UPI ref
  denominations   JSONB,                                    -- cash mode: {"500": 10, "100": 5}
  collected_by    UUID,
  collected_at    TIMESTAMPTZ DEFAULT NOW(),
  shift           VARCHAR(20),                              -- MORNING/AFTERNOON/NIGHT (cashier-set)
  notes           VARCHAR(500),
  reversed        BOOLEAN NOT NULL DEFAULT false,
  reversed_at     TIMESTAMPTZ,
  reversed_by     UUID,
  reversal_reason VARCHAR(255),
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON billing_payments(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_patient ON billing_payments(patient_uid);
CREATE INDEX IF NOT EXISTS idx_payments_collected_at ON billing_payments(collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON billing_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_mode ON billing_payments(mode, collected_at DESC);

-- ── Advance / Deposit ─────────────────────────────────────────────────
-- Money the patient pays UP-FRONT (typically at admission) before any
-- invoice is raised. Settled against future invoices via separate
-- billing_advance_settlements rows; balance auto-tracked.
CREATE TABLE IF NOT EXISTS billing_advances (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  admission_id    INTEGER,                                  -- typically tied to admission
  amount          NUMERIC(12,2) NOT NULL,
  balance         NUMERIC(12,2) NOT NULL,                   -- amount - sum(settlements) - refunds
  mode            VARCHAR(20) NOT NULL,
  reference       VARCHAR(255),
  collected_by    UUID,
  collected_at    TIMESTAMPTZ DEFAULT NOW(),
  status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',    -- ACTIVE/EXHAUSTED/REFUNDED
  notes           VARCHAR(500),
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advances_patient ON billing_advances(patient_uid);
CREATE INDEX IF NOT EXISTS idx_advances_admission ON billing_advances(admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_advances_status ON billing_advances(status);

CREATE TABLE IF NOT EXISTS billing_advance_settlements (
  id              SERIAL PRIMARY KEY,
  advance_id      INTEGER NOT NULL REFERENCES billing_advances(id) ON DELETE CASCADE,
  invoice_id      INTEGER NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  amount          NUMERIC(12,2) NOT NULL,
  settled_by      UUID,
  settled_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advance_settle_advance ON billing_advance_settlements(advance_id);
CREATE INDEX IF NOT EXISTS idx_advance_settle_invoice ON billing_advance_settlements(invoice_id);

-- ── Refunds ───────────────────────────────────────────────────────────
-- A refund is always against either an invoice (overpaid line) or an
-- advance (excess deposit at discharge). approval_status models the
-- two-step "raised by cashier → approved by manager" workflow that
-- Indian hospitals expect for any cash going out the door.
CREATE TABLE IF NOT EXISTS billing_refunds (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  invoice_id      INTEGER REFERENCES billing_invoices(id) ON DELETE SET NULL,
  advance_id      INTEGER REFERENCES billing_advances(id) ON DELETE SET NULL,
  amount          NUMERIC(12,2) NOT NULL,
  reason          VARCHAR(500) NOT NULL,
  mode            VARCHAR(20) NOT NULL,                     -- how the refund will be paid out
  reference       VARCHAR(255),                             -- txn id of payout
  approval_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',   -- PENDING/APPROVED/REJECTED/PAID
  raised_by       UUID,
  raised_at       TIMESTAMPTZ DEFAULT NOW(),
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  rejected_by     UUID,
  rejected_at     TIMESTAMPTZ,
  rejection_reason VARCHAR(255),
  paid_at         TIMESTAMPTZ,
  paid_by         UUID,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refunds_patient ON billing_refunds(patient_uid);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON billing_refunds(approval_status);
CREATE INDEX IF NOT EXISTS idx_refunds_raised_at ON billing_refunds(raised_at DESC);

-- Constraint: refund must reference exactly one of invoice/advance.
ALTER TABLE billing_refunds DROP CONSTRAINT IF EXISTS chk_refund_target;
ALTER TABLE billing_refunds ADD CONSTRAINT chk_refund_target CHECK (
  (invoice_id IS NOT NULL AND advance_id IS NULL) OR
  (invoice_id IS NULL AND advance_id IS NOT NULL)
);

-- ── Daily collection view ─────────────────────────────────────────────
-- Convenience view used by the daily-collection report screen. Indexed
-- access via collected_at; sliceable by mode / shift / collector.
CREATE OR REPLACE VIEW billing_daily_collection AS
SELECT
  DATE(p.collected_at AT TIME ZONE 'Asia/Kolkata') AS collection_date,
  p.shift,
  p.mode,
  p.collected_by,
  COUNT(*) AS payment_count,
  SUM(CASE WHEN p.reversed THEN 0 ELSE p.amount END) AS net_amount,
  SUM(p.amount) AS gross_amount,
  SUM(CASE WHEN p.reversed THEN p.amount ELSE 0 END) AS reversed_amount,
  p.tenant_id
FROM billing_payments p
GROUP BY 1, 2, 3, 4, p.tenant_id;

COMMIT;
