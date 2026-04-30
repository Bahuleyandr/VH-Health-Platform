-- Migration 116: Tier B — surgical / OR clinical entities.
--
-- The structural audit (HEALTHCARE_AI_SPEC_AUDIT.md §14) and the AI
-- backlog (AI_FEATURE_GAP_BACKLOG.md §9) both flag surgery as the
-- weakest single vertical: OT scheduling + AI block-time predictors
-- exist (clinical_ai_ot_block_suggestions, ot_schedules) but the
-- clinical OT documentation entities are absent. Operative notes,
-- consents, anesthesia records, implant tracking, and the WHO
-- Surgical Safety Checklist are all paper today.
--
-- This migration adds the seven first-class tables. Each row links
-- back to ot_schedules.id (the canonical surgical case record) so the
-- existing OT booking / scheduling flow stays untouched. Scoping is
-- by tenant_id (RLS-compatible) + ot_schedule_id.
--
-- Tables:
--   1. preop_checklists                  — pre-op verification (NPO,
--                                            consent, marked site,
--                                            allergies confirmed,
--                                            blood arranged, imaging
--                                            available). One row per
--                                            ot_schedule.
--   2. intraop_notes                     — operative note: incision,
--                                            findings, procedure
--                                            performed, specimen,
--                                            EBL, complications,
--                                            counts (sponge / sharp /
--                                            instrument).
--   3. postop_notes                      — recovery note: condition
--                                            on transfer, vitals,
--                                            pain score, drains,
--                                            dispositions. Multiple
--                                            allowed (every shift).
--   4. anesthesia_records                — pre-anesthesia eval +
--                                            ASA grade + technique +
--                                            agents + intraop events
--                                            + recovery. One per
--                                            ot_schedule.
--   5. surgical_implants                 — implant lot tracking
--                                            (manufacturer, ref,
--                                            lot, expiry, GUDID/UDI).
--                                            Multiple per case.
--   6. surgical_safety_checklists        — WHO three-phase (sign-in
--                                            before induction,
--                                            time-out before incision,
--                                            sign-out before patient
--                                            leaves theatre). Each
--                                            phase is its own row;
--                                            uniqueness on
--                                            (ot_schedule, phase).
--   7. postop_complication_alerts        — surgery-specific
--                                            complication events
--                                            (anastomotic leak, deep
--                                            SSI, return-to-theatre,
--                                            reintubation, DVT/PE)
--                                            distinct from generic
--                                            deterioration.
--
-- Decision-support only: AI surgical modules write candidate drafts to
-- clinical_ai_generations + clinical_ai_reviews (existing review
-- queue). Nothing here auto-publishes, auto-orders, or auto-finalises.
-- Surgeons sign off through the existing review surface.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. preop_checklists
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS preop_checklists (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id              INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  consent_signed              BOOLEAN NOT NULL DEFAULT false,
  consent_signed_at           TIMESTAMPTZ,
  consent_witness             VARCHAR(255),
  npo_status_confirmed        BOOLEAN NOT NULL DEFAULT false,
  npo_since                   TIMESTAMPTZ,
  site_marked                 BOOLEAN NOT NULL DEFAULT false,
  site_marked_by              UUID,
  allergies_reviewed          BOOLEAN NOT NULL DEFAULT false,
  allergies_summary           TEXT,
  blood_arranged              BOOLEAN NOT NULL DEFAULT false,
  blood_units                 INTEGER,
  imaging_available           BOOLEAN NOT NULL DEFAULT false,
  required_imaging            TEXT,
  preop_labs_reviewed         BOOLEAN NOT NULL DEFAULT false,
  preop_labs_summary          TEXT,
  antibiotic_prophylaxis      VARCHAR(255),
  antibiotic_given_at         TIMESTAMPTZ,
  patient_identity_verified   BOOLEAN NOT NULL DEFAULT false,
  procedure_verified          BOOLEAN NOT NULL DEFAULT false,
  anesthesia_consent          BOOLEAN NOT NULL DEFAULT false,
  special_equipment           TEXT,
  pending_items               JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_review_summary           TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'complete', 'incomplete_with_override')),
  completed_by                UUID,
  completed_at                TIMESTAMPTZ,
  override_reason             TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, ot_schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_preop_checklists_tenant_status
  ON preop_checklists (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_preop_checklists_schedule
  ON preop_checklists (ot_schedule_id);

-- ---------------------------------------------------------------------------
-- 2. intraop_notes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intraop_notes (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id              INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  surgeon                     UUID,
  primary_assistant           UUID,
  scrub_nurse                 UUID,
  circulator                  UUID,
  procedure_performed         VARCHAR(500),
  procedure_codes             TEXT[],
  incision_type               VARCHAR(160),
  position                    VARCHAR(120),
  findings                    TEXT,
  technique                   TEXT,
  specimens                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_blood_loss_ml     INTEGER,
  fluids_input                JSONB NOT NULL DEFAULT '{}'::jsonb,
  fluids_output               JSONB NOT NULL DEFAULT '{}'::jsonb,
  complications               TEXT,
  sponge_count_correct        BOOLEAN,
  sharp_count_correct         BOOLEAN,
  instrument_count_correct    BOOLEAN,
  count_discrepancy_notes     TEXT,
  drains_placed               JSONB NOT NULL DEFAULT '[]'::jsonb,
  closure_method              VARCHAR(255),
  start_time                  TIMESTAMPTZ,
  end_time                    TIMESTAMPTZ,
  status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'finalized', 'amended')),
  finalized_by                UUID,
  finalized_at                TIMESTAMPTZ,
  ai_assist_generation_id     INTEGER,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intraop_notes_tenant_schedule
  ON intraop_notes (tenant_id, ot_schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intraop_notes_status
  ON intraop_notes (tenant_id, status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 3. postop_notes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS postop_notes (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id              INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  authored_by                 UUID,
  pod_number                  INTEGER,
  recovery_phase              VARCHAR(40)
    CHECK (recovery_phase IS NULL OR recovery_phase IN (
      'pacu', 'phase1', 'phase2', 'ward', 'hdu', 'icu', 'discharged'
    )),
  vitals                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  pain_score                  INTEGER CHECK (pain_score IS NULL OR (pain_score >= 0 AND pain_score <= 10)),
  pain_management_plan        TEXT,
  drain_status                JSONB NOT NULL DEFAULT '[]'::jsonb,
  wound_status                VARCHAR(160),
  diet_advanced_to            VARCHAR(120),
  ambulation                  VARCHAR(120),
  bowel_function              VARCHAR(120),
  urine_output_ml             INTEGER,
  complications_noted         TEXT,
  pending_orders              JSONB NOT NULL DEFAULT '[]'::jsonb,
  follow_up_actions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  disposition                 VARCHAR(160),
  status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'finalized', 'amended')),
  finalized_by                UUID,
  finalized_at                TIMESTAMPTZ,
  ai_assist_generation_id     INTEGER,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_postop_notes_tenant_schedule
  ON postop_notes (tenant_id, ot_schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_postop_notes_phase
  ON postop_notes (tenant_id, recovery_phase, created_at DESC)
  WHERE recovery_phase IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. anesthesia_records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS anesthesia_records (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id              INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  anesthetist                 UUID,
  assistant                   UUID,
  preop_assessment_complete   BOOLEAN NOT NULL DEFAULT false,
  asa_grade                   VARCHAR(8)
    CHECK (asa_grade IS NULL OR asa_grade IN ('I', 'II', 'III', 'IV', 'V', 'VI', 'IE', 'IIE', 'IIIE', 'IVE', 'VE')),
  airway_assessment           JSONB NOT NULL DEFAULT '{}'::jsonb,
  preop_meds_held             JSONB NOT NULL DEFAULT '[]'::jsonb,
  technique                   VARCHAR(80)
    CHECK (technique IS NULL OR technique IN (
      'general', 'regional_spinal', 'regional_epidural', 'regional_block',
      'mac', 'local', 'combined'
    )),
  airway_managed              VARCHAR(40)
    CHECK (airway_managed IS NULL OR airway_managed IN (
      'mask', 'lma', 'ett_oral', 'ett_nasal', 'tracheostomy', 'awake_fiberoptic', 'none'
    )),
  intubation_grade            VARCHAR(8),
  agents_used                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  fluids_in_ml                INTEGER,
  blood_products_in           JSONB NOT NULL DEFAULT '[]'::jsonb,
  urine_output_ml             INTEGER,
  blood_loss_ml               INTEGER,
  events                      JSONB NOT NULL DEFAULT '[]'::jsonb,
  complications               TEXT,
  recovery_destination        VARCHAR(40),
  pain_plan                   TEXT,
  ponv_prophylaxis            TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'finalized', 'amended')),
  finalized_by                UUID,
  finalized_at                TIMESTAMPTZ,
  ai_precheck_generation_id   INTEGER,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, ot_schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_anesthesia_records_tenant_status
  ON anesthesia_records (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_anesthesia_records_asa
  ON anesthesia_records (tenant_id, asa_grade)
  WHERE asa_grade IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. surgical_implants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS surgical_implants (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id              INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  implant_type                VARCHAR(160) NOT NULL,
  manufacturer                VARCHAR(255),
  brand_name                  VARCHAR(255),
  product_name                VARCHAR(255),
  reference_number            VARCHAR(120),
  lot_number                  VARCHAR(120),
  serial_number               VARCHAR(160),
  udi                         VARCHAR(255),
  gudid_di                    VARCHAR(120),
  size                        VARCHAR(80),
  side                        VARCHAR(20)
    CHECK (side IS NULL OR side IN ('left', 'right', 'bilateral', 'midline', 'n/a')),
  expiry_date                 DATE,
  sterilization_lot           VARCHAR(120),
  implanted_by                UUID,
  implanted_at                TIMESTAMPTZ,
  removal_date                TIMESTAMPTZ,
  removal_reason              TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'in_situ'
    CHECK (status IN ('planned', 'in_situ', 'removed', 'replaced', 'recalled')),
  recall_reference            VARCHAR(255),
  notes                       TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_surgical_implants_tenant_patient
  ON surgical_implants (tenant_id, patient_uid, status);
CREATE INDEX IF NOT EXISTS idx_surgical_implants_schedule
  ON surgical_implants (ot_schedule_id);
CREATE INDEX IF NOT EXISTS idx_surgical_implants_udi
  ON surgical_implants (tenant_id, udi)
  WHERE udi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surgical_implants_lot
  ON surgical_implants (tenant_id, manufacturer, lot_number)
  WHERE lot_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. surgical_safety_checklists (WHO 3-phase)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS surgical_safety_checklists (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id              INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  phase                       VARCHAR(20) NOT NULL
    CHECK (phase IN ('sign_in', 'time_out', 'sign_out')),
  performed_by                UUID,
  performed_at                TIMESTAMPTZ,
  items                       JSONB NOT NULL DEFAULT '[]'::jsonb,
  all_items_confirmed         BOOLEAN NOT NULL DEFAULT false,
  outstanding_items           JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                      VARCHAR(20) NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'complete', 'incomplete_with_override')),
  override_reason             TEXT,
  override_authorized_by      UUID,
  notes                       TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, ot_schedule_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_safety_checklists_schedule
  ON surgical_safety_checklists (ot_schedule_id, phase);
CREATE INDEX IF NOT EXISTS idx_safety_checklists_tenant_status
  ON surgical_safety_checklists (tenant_id, status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 7. postop_complication_alerts (surgery-specific, distinct from generic deterioration)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS postop_complication_alerts (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ot_schedule_id              INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  complication_type           VARCHAR(80) NOT NULL
    CHECK (complication_type IN (
      'anastomotic_leak', 'deep_ssi', 'superficial_ssi', 'wound_dehiscence',
      'return_to_theatre', 'reintubation', 'dvt', 'pe', 'mi', 'cva',
      'aki', 'sepsis', 'hemorrhage', 'ileus', 'organ_injury', 'other'
    )),
  severity                    VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  detected_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by                 UUID,
  detection_source            VARCHAR(40)
    CHECK (detection_source IS NULL OR detection_source IN (
      'manual', 'ai_alert', 'lab_trigger', 'vitals_trigger', 'imaging', 'nursing'
    )),
  description                 TEXT,
  clavien_dindo_grade         VARCHAR(8)
    CHECK (clavien_dindo_grade IS NULL OR clavien_dindo_grade IN ('I', 'II', 'IIIa', 'IIIb', 'IVa', 'IVb', 'V')),
  intervention                TEXT,
  intervention_at             TIMESTAMPTZ,
  outcome                     VARCHAR(40)
    CHECK (outcome IS NULL OR outcome IN (
      'resolved', 'stable', 'worsening', 'fatal', 'transferred', 'unknown'
    )),
  ai_alert_generation_id      INTEGER,
  acknowledged_by             UUID,
  acknowledged_at             TIMESTAMPTZ,
  status                      VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'false_positive')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_postop_complications_schedule
  ON postop_complication_alerts (ot_schedule_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_postop_complications_tenant_status
  ON postop_complication_alerts (tenant_id, status, severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_postop_complications_patient
  ON postop_complication_alerts (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;

COMMIT;
