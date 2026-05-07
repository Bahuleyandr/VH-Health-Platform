-- Migration 166: Bio-medical waste register + Drug controller returns
-- (Sprint 20).
--
-- Two related record-keeping surfaces, both required by Indian
-- regulators and both currently kept on paper at most facilities.
--
-- 1. BMW Register (BMW Rules 2016, MoEF&CC). Every healthcare facility
--    generating bio-medical waste must record daily generation in
--    each of the four colour categories: yellow (anatomical / soiled),
--    red (recyclable plastic), blue (glass / metal), white (sharps).
--    SPCB submits annual Form IV based on this data. Penalty for
--    non-record-keeping is up to ₹10 lakh per the EPA 1986.
--
-- 2. Drug Controller Returns. Schedule H1 (antibiotics, narcotics) +
--    Schedule X (psychotropics) require dispense logs with prescriber
--    licence. Expired stock must be physically returned to manufacturer
--    or disposed via the State drug controller. Documentation lives
--    in two places today (a manual register + manufacturer's CRM);
--    we replace the manual side.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- BIO-MEDICAL WASTE REGISTER
-- ════════════════════════════════════════════════════════════════════
--
-- Each row = one collection event (typically a ward → CSSD handover or
-- a CSSD → CBWTF dispatch). The four BMW categories are colour-coded
-- under Schedule I of BMW Rules 2016:
--
--   YELLOW  — human anatomical, soiled, expired meds, cytotoxic, lab
--   RED     — contaminated recyclable plastic (IV sets, syringes, gloves)
--   WHITE   — sharps (needles, blades) — translucent puncture-proof
--   BLUE    — glass + metal implants

CREATE TABLE IF NOT EXISTS bmw_waste_log (
  id                      SERIAL PRIMARY KEY,
  log_date                DATE NOT NULL DEFAULT CURRENT_DATE,
  log_time                TIME NOT NULL DEFAULT CURRENT_TIME,

  -- Source: department / ward generating the waste
  source_dept             VARCHAR(80) NOT NULL,
  source_ward             VARCHAR(80),

  -- Destination: 'cssd' (in-hospital storage), 'cbwtf' (Common
  -- Bio-medical Waste Treatment Facility — final dispatch), 'incinerator'
  -- (in-house if licensed), 'return_pharma' (cytotoxic returns).
  destination             VARCHAR(40) NOT NULL,

  -- Quantities by colour (in kg, precise to 100g — that's what SPCB
  -- annual returns require). Rows where only one category was
  -- generated leave the others zero.
  yellow_kg               NUMERIC(8, 2) NOT NULL DEFAULT 0,
  red_kg                  NUMERIC(8, 2) NOT NULL DEFAULT 0,
  white_kg                NUMERIC(8, 2) NOT NULL DEFAULT 0,
  blue_kg                 NUMERIC(8, 2) NOT NULL DEFAULT 0,
  -- Total auto-computed
  total_kg                NUMERIC(8, 2) GENERATED ALWAYS AS (
    yellow_kg + red_kg + white_kg + blue_kg
  ) STORED,

  -- Bag tracking — each bag has a unique barcode under BMW Rules.
  bag_count               INTEGER,
  bag_barcodes            TEXT[],                       -- nullable for legacy/manual entries

  -- Pickup / dispatch
  vehicle_no              VARCHAR(40),                  -- CBWTF vehicle reg
  cbwtf_operator          VARCHAR(120),                 -- name of the licensed operator
  manifest_no             VARCHAR(60),                  -- the State manifest tracking no
  weighed_by              VARCHAR(120),
  received_by             VARCHAR(120),                 -- counterparty signatory
  -- Photo evidence (R2 keys) — most SPCB inspectors check for these
  photo_keys              TEXT[],

  notes                   TEXT,

  -- Auto-flag if any colour goes over the daily ceiling (configurable
  -- per facility — kept here as a static sanity threshold).
  ceiling_exceeded        BOOLEAN NOT NULL DEFAULT false,

  created_by              UUID,
  tenant_id               UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bmw_log_date
  ON bmw_waste_log(tenant_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_bmw_log_source
  ON bmw_waste_log(tenant_id, source_dept, log_date DESC);

-- Monthly rollup view for SPCB Form IV (annual return = sum of
-- monthlies). Form IV asks for kg by category by month.
CREATE OR REPLACE VIEW bmw_monthly_rollup AS
SELECT
  tenant_id,
  DATE_TRUNC('month', log_date)::date AS month_start,
  SUM(yellow_kg)::numeric(10, 2) AS yellow_kg,
  SUM(red_kg)::numeric(10, 2)    AS red_kg,
  SUM(white_kg)::numeric(10, 2)  AS white_kg,
  SUM(blue_kg)::numeric(10, 2)   AS blue_kg,
  SUM(total_kg)::numeric(10, 2)  AS total_kg,
  COUNT(*)::int                  AS log_entries,
  COUNT(DISTINCT source_dept)::int AS departments_logging
FROM bmw_waste_log
GROUP BY tenant_id, DATE_TRUNC('month', log_date);

-- ════════════════════════════════════════════════════════════════════
-- DRUG CONTROLLER RETURNS (expired / damaged / recalled stock)
-- ════════════════════════════════════════════════════════════════════
--
-- Schedule H1 / Schedule X drugs require additional documentation when
-- returned to manufacturer or disposed via SDC. We track the full
-- chain: identification → quarantine → approval → physical disposition.

CREATE TABLE IF NOT EXISTS drug_return_batches (
  id                      SERIAL PRIMARY KEY,
  batch_serial            VARCHAR(40) NOT NULL,         -- per-facility serial
  initiated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  initiated_by            UUID,
  reason                  VARCHAR(40) NOT NULL          -- 'expired' / 'damaged' / 'recalled' / 'temp_breach' / 'other'
    CHECK (reason IN ('expired', 'damaged', 'recalled', 'temp_breach', 'near_expiry', 'other')),

  -- Counterparty
  counterparty_kind       VARCHAR(20) NOT NULL          -- 'manufacturer' / 'distributor' / 'sdc' (state drug controller)
    CHECK (counterparty_kind IN ('manufacturer', 'distributor', 'sdc')),
  counterparty_name       VARCHAR(160) NOT NULL,
  counterparty_licence_no VARCHAR(80),

  -- Workflow
  status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'quarantined', 'approved', 'dispatched', 'acknowledged', 'cancelled')),
  quarantined_at          TIMESTAMPTZ,
  quarantine_location     VARCHAR(80),
  approved_at             TIMESTAMPTZ,
  approved_by             UUID,                          -- chief pharmacist UID
  dispatched_at           TIMESTAMPTZ,
  -- Acknowledgement from counterparty (reference no on receipt note)
  acknowledged_at         TIMESTAMPTZ,
  ack_reference_no        VARCHAR(120),

  -- Physical disposition method (SDC requires this on Form-31C)
  disposition_method      VARCHAR(40),                   -- 'incinerated' / 'returned_to_manufacturer' / 'destroyed_via_sdc' / 'witnessed_destruction'

  -- Photographic evidence + manifest scans
  photo_keys              TEXT[],
  manifest_keys           TEXT[],
  notes                   TEXT,

  tenant_id               UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, batch_serial)
);

CREATE INDEX IF NOT EXISTS idx_drug_return_status
  ON drug_return_batches(tenant_id, status, initiated_at DESC);

-- Each line = one drug × batch in the return.
CREATE TABLE IF NOT EXISTS drug_return_lines (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES drug_return_batches(id) ON DELETE CASCADE,

  drug_name           VARCHAR(160) NOT NULL,
  drug_code           VARCHAR(40),                       -- internal drug master code
  -- Schedule classification matters for dispatch rules.
  schedule            VARCHAR(10) CHECK (schedule IN ('H', 'H1', 'X', 'G', 'C', 'C1', 'NONE')),
  manufacturer        VARCHAR(160),
  -- Manufacturer's batch # is what the supplier verifies on receipt
  mfr_batch_no        VARCHAR(60) NOT NULL,
  mfr_date            DATE,
  expiry_date         DATE,

  qty_units           INTEGER NOT NULL,
  qty_uom             VARCHAR(20) NOT NULL DEFAULT 'unit', -- 'unit' / 'strip' / 'vial' / 'box'
  unit_cost_paise     INTEGER,                            -- procurement cost in paise (₹×100), for accounting
  total_value_paise   INTEGER GENERATED ALWAYS AS (qty_units * COALESCE(unit_cost_paise, 0)) STORED,

  storage_condition_at_return VARCHAR(40),                -- 'cold_chain_2_8c' / 'room_temp' / 'cytotoxic' / 'controlled_substance'
  is_narcotic         BOOLEAN NOT NULL DEFAULT false,    -- narcotic schedule (H/X) — extra witnessing
  witness_uid         UUID,                               -- 2nd-pharmacist witness for H1/X disposal
  witness_name        VARCHAR(160),

  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drug_return_lines_batch
  ON drug_return_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_drug_return_lines_drug
  ON drug_return_lines(drug_name);

-- Per-batch serial counter (so two different facilities don't collide
-- on serials when the platform goes multi-tenant in production).
CREATE TABLE IF NOT EXISTS drug_return_serial_counter (
  tenant_id   UUID PRIMARY KEY,
  next_serial INTEGER NOT NULL DEFAULT 1
);

COMMIT;
