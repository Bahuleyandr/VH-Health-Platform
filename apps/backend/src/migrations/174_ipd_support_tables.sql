-- 174_ipd_support_tables.sql
--
-- Three IPD support subsystems landing together because they're tightly
-- coupled to the admission lifecycle (D2 closes the loop financially +
-- this migration adds the operational tables the discharge cascade
-- assumes exist).
--
--   1. advance_deposits — money collected at admit / mid-stay against
--      this admission's final bill. Receipt series is RCT-YYYYMM-NNNN
--      (distinct from INV invoices). Partial refunds modelled as
--      negative-amount sibling rows so the trail is auditable.
--   2. attendant_passes — 2 per patient, auto-issued at admit, color-
--      coded by ward. Future: phone-link; today: printed barcode +
--      patient name. Per project decision 2026-05-09.
--   3. ward_indents + ward_indent_items — pharmacy/stores → ward
--      consumables flow. State machine:
--      requested → approved → issued → received (rejected as
--      terminal). Stock decrement happens at issued.
--
-- Plus: wards gains attendant_pass_color + attendant_pass_screening_level
-- so the UI / security guard view knows which pass shape to expect.
--
-- Architectural item A4. No swarm finding directly — these were
-- referenced as "missing IPD subsystem" in multiple findings:
--   2026-05-08-inpatient-admission-admission-no-deposit-attendant-tables
--   2026-05-08-inpatient-admission-pharmacy-no-ipd-ward-indent

BEGIN;

-- ── 1. Advance deposits ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advance_deposits (
  id                SERIAL PRIMARY KEY,
  admission_id      INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  patient_uid       UUID NOT NULL,
  receipt_number    VARCHAR(40) NOT NULL UNIQUE,
  amount            NUMERIC(10, 2) NOT NULL,
    -- positive for collection; partial refund modelled as a sibling
    -- negative-amount row pointing at parent_deposit_id.
  parent_deposit_id INTEGER REFERENCES advance_deposits(id) ON DELETE SET NULL,
  payment_method    VARCHAR(40) NOT NULL,
    -- cash | card | upi | cheque | online | bank_transfer
  payment_reference TEXT,
    -- UTR / cheque no / txn id / etc.
  purpose           VARCHAR(40) NOT NULL DEFAULT 'admission_advance',
    -- admission_advance | package_advance | attendant_deposit | security_deposit
  is_refund         BOOLEAN NOT NULL DEFAULT FALSE,
  notes             TEXT,
  collected_by      UUID NOT NULL,
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advance_deposits_admission
  ON advance_deposits(admission_id);
CREATE INDEX IF NOT EXISTS idx_advance_deposits_patient
  ON advance_deposits(patient_uid);
CREATE INDEX IF NOT EXISTS idx_advance_deposits_parent
  ON advance_deposits(parent_deposit_id) WHERE parent_deposit_id IS NOT NULL;

-- ── 2. Attendant passes ─────────────────────────────────────────────
-- 2 auto-issued per admission (admitPatient hook). Ward-color
-- snapshotted at issue. Expires at discharge. Future: phone-linked.

ALTER TABLE wards
  ADD COLUMN IF NOT EXISTS attendant_pass_color           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS attendant_pass_screening_level VARCHAR(20) DEFAULT 'standard';

CREATE TABLE IF NOT EXISTS attendant_passes (
  id                     SERIAL PRIMARY KEY,
  admission_id           INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  patient_uid            UUID NOT NULL,
  pass_number            VARCHAR(40) NOT NULL UNIQUE,
  pass_index             INTEGER NOT NULL,    -- 1 or 2 (per project decision)
  patient_name_snapshot  VARCHAR(255),
  pass_color             VARCHAR(20),         -- snapshot from ward
  ward_at_issue          VARCHAR(80),
  screening_level        VARCHAR(20),         -- snapshot from ward
  status                 VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at             TIMESTAMPTZ,         -- null = expires at discharge
  issued_by              UUID NOT NULL,
  issued_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by             UUID,
  revoked_at             TIMESTAMPTZ,
  revocation_reason      TEXT,
  notes                  TEXT,
  tenant_id              UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (admission_id, pass_index)
);

CREATE INDEX IF NOT EXISTS idx_attendant_passes_admission
  ON attendant_passes(admission_id);
CREATE INDEX IF NOT EXISTS idx_attendant_passes_active
  ON attendant_passes(status) WHERE status = 'active';

-- ── 3. Ward indents ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ward_indents (
  id                SERIAL PRIMARY KEY,
  indent_number     VARCHAR(40) NOT NULL UNIQUE,   -- WI-YYYYMMDD-NNNN
  ward_id           INTEGER REFERENCES wards(id) ON DELETE SET NULL,
  ward_name         VARCHAR(80),                   -- snapshot
  indent_type       VARCHAR(40) NOT NULL DEFAULT 'pharmacy',
    -- pharmacy | consumables | linen | sterile_supplies
  status            VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'issued', 'received')),
  requested_by      UUID NOT NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by       UUID,
  approved_at       TIMESTAMPTZ,
  issued_by         UUID,
  issued_at         TIMESTAMPTZ,
  received_by       UUID,
  received_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  notes             TEXT,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ward_indent_items (
  id                  SERIAL PRIMARY KEY,
  ward_indent_id      INTEGER NOT NULL REFERENCES ward_indents(id) ON DELETE CASCADE,
  pharmacy_catalog_id INTEGER,                  -- nullable for non-catalog items
  item_name           VARCHAR(255) NOT NULL,
  quantity_requested  NUMERIC(10, 2) NOT NULL,
  quantity_issued     NUMERIC(10, 2),
  unit                VARCHAR(20),
    -- 'tabs' | 'units' | 'bottles' | 'rolls' | etc.
  unit_price          NUMERIC(10, 2),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ward_indents_ward_status
  ON ward_indents(ward_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ward_indents_pending
  ON ward_indents(status, requested_at)
  WHERE status IN ('requested', 'approved', 'issued');
CREATE INDEX IF NOT EXISTS idx_ward_indent_items_indent
  ON ward_indent_items(ward_indent_id);

COMMIT;
