-- Migration 150: Schedule H / H1 / X chain-of-custody register (Sprint 2).
--
-- Indian Drugs and Cosmetics Rules require pharmacies to maintain a
-- separate, witnessed register for narcotic + psychotropic substances:
--
--   * Schedule H  — Rx-only drugs (most antibiotics, hormones); register
--                   recommended but not mandatory for routine.
--   * Schedule H1 — antibiotics where misuse causes resistance + a
--                   subset of psychotropic substances; register required
--                   under Rule 65(11A).
--   * Schedule X  — narcotic + psychotropic substances; register
--                   mandatory, signed witness on every dispense, kept
--                   for 2 years from last entry.
--
-- The pharmacy_stock_movements table records every transaction, but
-- regulators want a *separate, append-only, witness-signed* sub-register
-- specifically for the controlled-class drugs. This migration adds:
--
--   1) pharmacy_schedule_register (the controlled-substance register)
--   2) A view that surfaces it joined with item details for the
--      inspector-friendly printable register.
--
-- Idempotent CREATE statements; safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS pharmacy_schedule_register (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL,
  facility_id                 INTEGER,
  inventory_item_id           INTEGER NOT NULL,
  inventory_batch_id          INTEGER,
  schedule_class              VARCHAR(20) NOT NULL,        -- H / H1 / X (snapshot from item at entry time)
  movement_kind               VARCHAR(40) NOT NULL,        -- receive / dispense / return / dispose / recall / adjust
  quantity                    NUMERIC(14, 4) NOT NULL,     -- always positive; movement_kind decides sign semantics
  unit_label                  VARCHAR(40),
  running_balance             NUMERIC(14, 4) NOT NULL,     -- after this entry; computed at insert time
  patient_uid                 UUID,
  prescription_id             INTEGER,
  prescription_number         VARCHAR(80),
  prescriber_uid              UUID,                        -- prescribing doctor for dispense
  prescriber_name             VARCHAR(255),
  prescriber_registration     VARCHAR(80),                 -- MCI / state council reg number
  patient_id_proof_type       VARCHAR(40),                 -- aadhaar / passport / voter / driving / other
  patient_id_proof_last4      VARCHAR(4),                  -- last 4 digits only; never store full ID
  performed_by                UUID NOT NULL,               -- pharmacist
  performed_by_name           VARCHAR(255),
  witness_uid                 UUID,                        -- second pharmacist / nurse / pharmacy-in-charge
  witness_name                VARCHAR(255),
  reference_movement_id       INTEGER,                     -- back-pointer to pharmacy_stock_movements row
  notes                       TEXT,
  -- For audit: register entries are append-only. Corrections are made
  -- via a new "adjust" entry referencing the original via notes.
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedule_register_tenant_class_time
  ON pharmacy_schedule_register (tenant_id, schedule_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_register_item
  ON pharmacy_schedule_register (inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_register_patient
  ON pharmacy_schedule_register (patient_uid)
  WHERE patient_uid IS NOT NULL;

-- Inspector-friendly view: register entries with item + batch context.
-- Drives the printable register report. SECURITY: filter by tenant_id
-- in every consumer; the view itself has no RLS.
CREATE OR REPLACE VIEW pharmacy_schedule_register_full AS
SELECT
  r.id,
  r.tenant_id,
  r.created_at,
  r.schedule_class,
  r.movement_kind,
  i.sku_code,
  i.display_name,
  i.generic_name,
  i.brand_name,
  i.strength,
  i.form,
  b.batch_number,
  b.expiry_date,
  r.quantity,
  r.unit_label,
  r.running_balance,
  r.patient_uid,
  r.prescription_number,
  r.prescriber_name,
  r.prescriber_registration,
  r.patient_id_proof_type,
  r.patient_id_proof_last4,
  r.performed_by_name,
  r.witness_name,
  r.notes
FROM pharmacy_schedule_register r
JOIN pharmacy_inventory_items i ON i.id = r.inventory_item_id
LEFT JOIN pharmacy_inventory_batches b ON b.id = r.inventory_batch_id;

-- Daily expiry scan results — a cache the cron job populates so the UI
-- can show "expires in N days" without scanning every batch live.
-- Keyed by (tenant_id, batch_id) so re-running the job upserts cleanly.
CREATE TABLE IF NOT EXISTS pharmacy_expiry_scan_cache (
  tenant_id          UUID NOT NULL,
  inventory_batch_id INTEGER NOT NULL,
  inventory_item_id  INTEGER NOT NULL,
  expiry_date        DATE NOT NULL,
  remaining_quantity NUMERIC(14, 4) NOT NULL,
  days_to_expiry     INTEGER NOT NULL,
  bucket             VARCHAR(20) NOT NULL,    -- expired / 0-30 / 31-60 / 61-90
  scanned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, inventory_batch_id)
);

CREATE INDEX IF NOT EXISTS idx_expiry_scan_bucket
  ON pharmacy_expiry_scan_cache (tenant_id, bucket, days_to_expiry);

COMMIT;
