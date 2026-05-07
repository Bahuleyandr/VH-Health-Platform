-- Migration 163: Anesthesia time-series chart + Microbiology C&S
-- (Sprint 17).
--
-- Two long-standing gaps closed in one migration.
--
-- 1. Anesthesia chart — migration 116 added an anesthesia_records
--    header row (one per case). What was missing is the every-5-minute
--    time-series the anaesthetist records during surgery. This is
--    where every Indian OR record falls down today.
--
-- 2. Microbiology — Sprint 3 lab handles biochemistry but micro has
--    its own data shape: an order grows into one or more isolates,
--    each isolate has an antibiogram (organism × antibiotic →
--    susceptibility + MIC). This is what infection control + ICU
--    antibiotic stewardship needs.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- ANESTHESIA TIME-SERIES CHART
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS anesthesia_chart_entries (
  id                  SERIAL PRIMARY KEY,
  ot_schedule_id      INTEGER NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Vitals
  hr                  INTEGER,
  sbp                 INTEGER,
  dbp                 INTEGER,
  map                 INTEGER,
  spo2                INTEGER,
  etco2               INTEGER,
  rr                  INTEGER,
  temp_c              NUMERIC(4, 1),
  -- Ventilation (when intubated)
  vent_mode           VARCHAR(20),               -- volume_control / pressure_control / sims_v / spontaneous
  fio2_pct            INTEGER,
  tidal_volume_ml     INTEGER,
  peep_cmh2o          NUMERIC(4, 1),
  airway_pressure     INTEGER,
  -- Drugs given since last entry (one row of "what changed in this 5-min slice")
  drugs_given         JSONB DEFAULT '[]'::jsonb, -- [{name, dose_mg, route, time}]
  -- Fluids since last entry
  iv_fluids_ml        INTEGER,
  blood_loss_ml       INTEGER,
  urine_output_ml     INTEGER,
  -- Free-text events
  event_note          TEXT,
  recorded_by         UUID,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anesthesia_chart_schedule
  ON anesthesia_chart_entries(ot_schedule_id, recorded_at);

-- ════════════════════════════════════════════════════════════════════
-- MICROBIOLOGY ORDER + ISOLATE + ANTIBIOGRAM
-- ════════════════════════════════════════════════════════════════════

-- 1. Order — patient comes for a culture.
CREATE TABLE IF NOT EXISTS micro_orders (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  admission_id    INTEGER,
  ordered_by      UUID,
  ordered_by_name VARCHAR(160),
  -- Specimen
  specimen_type   VARCHAR(40) NOT NULL,           -- blood / urine / sputum / pus / csf / stool / wound / et_secretion / tip / other
  specimen_site   VARCHAR(120),                   -- "right hip wound" / "central line tip"
  collected_at    TIMESTAMPTZ,
  collected_by    UUID,
  -- What's being looked for. Picks dictate which growth media + reporting workflow.
  test_kind       VARCHAR(40) NOT NULL DEFAULT 'culture_sensitivity'
    CHECK (test_kind IN ('culture_sensitivity', 'gram_stain', 'afb_smear', 'afb_culture', 'fungal_culture', 'mrsa_screen', 'esbl_screen', 'cre_screen', 'kpc_screen')),
  clinical_notes  TEXT,
  -- Workflow
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'collected', 'received', 'in_progress', 'preliminary', 'final', 'cancelled')),
  received_at     TIMESTAMPTZ,
  preliminary_at  TIMESTAMPTZ,
  finalised_at    TIMESTAMPTZ,
  finalised_by    UUID,                           -- microbiologist
  finalised_by_name VARCHAR(160),
  -- High-level interpretation that goes back to the floor.
  growth_status   VARCHAR(30),                    -- 'no_growth' / 'normal_flora' / 'pathogen_isolated' / 'mixed_growth' / 'contaminated'
  comments        TEXT,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_micro_orders_patient
  ON micro_orders(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_micro_orders_status
  ON micro_orders(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_micro_orders_pending_signoff
  ON micro_orders(tenant_id) WHERE status IN ('preliminary', 'in_progress');

-- 2. Isolate — one organism grown out of an order. Multiple per order
-- when multiple organisms cohabit (especially urine, mixed growth).
CREATE TABLE IF NOT EXISTS micro_isolates (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES micro_orders(id) ON DELETE CASCADE,
  organism_name   VARCHAR(160) NOT NULL,         -- 'Escherichia coli' / 'Klebsiella pneumoniae'
  organism_code   VARCHAR(40),                   -- LOINC / SNOMED if available
  colony_count    VARCHAR(60),                   -- '>10^5 CFU/mL' (urine) / '4+'
  -- Resistance markers — flagged as separate booleans for fast querying
  -- by infection control. The antibiogram captures detail; these flags
  -- are the "keywords" infection control filters by.
  is_mrsa         BOOLEAN NOT NULL DEFAULT false,
  is_esbl         BOOLEAN NOT NULL DEFAULT false,
  is_amp_c        BOOLEAN NOT NULL DEFAULT false,
  is_carbapenemase BOOLEAN NOT NULL DEFAULT false,
  is_vre          BOOLEAN NOT NULL DEFAULT false,
  is_xdr          BOOLEAN NOT NULL DEFAULT false,
  comments        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_micro_isolates_order
  ON micro_isolates(order_id);
CREATE INDEX IF NOT EXISTS idx_micro_isolates_resistance
  ON micro_isolates(id)
  WHERE is_mrsa OR is_esbl OR is_amp_c OR is_carbapenemase OR is_vre OR is_xdr;

-- 3. Antibiogram — per-isolate × per-antibiotic susceptibility.
CREATE TABLE IF NOT EXISTS micro_sensitivities (
  id              SERIAL PRIMARY KEY,
  isolate_id      INTEGER NOT NULL REFERENCES micro_isolates(id) ON DELETE CASCADE,
  antibiotic_code VARCHAR(40) NOT NULL,           -- ATC / WHONET code
  antibiotic_name VARCHAR(120) NOT NULL,
  -- CLSI category. 'I' (Intermediate) is renamed in 2019+ to
  -- "Susceptible-Dose-Dependent" in some contexts; we keep the legacy
  -- letter for compatibility with WHONET imports.
  result          VARCHAR(2) NOT NULL CHECK (result IN ('S', 'I', 'R', 'SDD', 'NS')),
  mic_value       NUMERIC(8, 3),                  -- Minimum Inhibitory Concentration
  mic_unit        VARCHAR(20) DEFAULT 'mg/L',
  zone_diameter_mm INTEGER,                       -- if disk-diffusion was used
  method          VARCHAR(30),                    -- vitek2 / disk_diffusion / etest / broth_microdilution
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (isolate_id, antibiotic_code)
);

CREATE INDEX IF NOT EXISTS idx_micro_sensitivities_isolate
  ON micro_sensitivities(isolate_id);

-- 4. Antibiogram aggregate view (rolling 90-day) for stewardship.
CREATE OR REPLACE VIEW antibiogram_90d AS
SELECT
  i.organism_name,
  s.antibiotic_code,
  s.antibiotic_name,
  COUNT(*)::int AS total_tested,
  COUNT(*) FILTER (WHERE s.result = 'S')::int AS susceptible_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE s.result = 'S') / NULLIF(COUNT(*), 0), 1) AS susceptible_pct,
  o.tenant_id
FROM micro_sensitivities s
JOIN micro_isolates i ON i.id = s.isolate_id
JOIN micro_orders o ON o.id = i.order_id
WHERE o.created_at > NOW() - INTERVAL '90 days'
GROUP BY i.organism_name, s.antibiotic_code, s.antibiotic_name, o.tenant_id;

COMMIT;
