-- Migration 233: Repair — ensure ED operational tables exist.
--
-- Context: the old non-fatal migration runner (pre-2026-05-01) silently
-- swallowed migration 126 failures on some environments, leaving
-- emergency_visits / triage_assessments / ambulance_requests / mlc_records
-- absent while the _migrations tracker may or may not show 126 as applied.
-- After the runner was made fatal, any restart against an affected DB would
-- either crash (if 126 wasn't tracked) or silently skip (if 126 was tracked
-- despite the tables being absent).
--
-- This migration is fully idempotent:
--   * CREATE TABLE IF NOT EXISTS — no-op if the table already exists.
--   * ADD COLUMN IF NOT EXISTS   — no-op if the column already exists.
--   * CREATE INDEX IF NOT EXISTS — no-op if the index already exists.
--   * DO $$ IF NOT EXISTS ...    — no-op if the constraint already exists.
--
-- Finding: 2026-05-08-emergency-walk-in-nurse-ed-triage-tables-missing

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. emergency_visits
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS emergency_visits (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER,
  visit_number                VARCHAR(80) NOT NULL,
  patient_uid                 UUID,
  arrival_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  arrival_mode                VARCHAR(40) NOT NULL DEFAULT 'walk_in',
  ambulance_request_id        INTEGER,
  chief_complaint             TEXT,
  attending_doctor_uid        UUID,
  triage_priority             VARCHAR(20),
  status                      VARCHAR(20) NOT NULL DEFAULT 'arriving',
  bed_assigned_id             INTEGER,
  disposition                 VARCHAR(60),
  triage_started_at           TIMESTAMPTZ,
  treatment_started_at        TIMESTAMPTZ,
  disposition_at              TIMESTAMPTZ,
  departure_at                TIMESTAMPTZ,
  is_mlc                      BOOLEAN NOT NULL DEFAULT false,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, visit_number)
);

-- encounter_id added by migration 224; idempotent here so repair applies
-- even when 224 is already tracked but the table was never created.
ALTER TABLE emergency_visits
  ADD COLUMN IF NOT EXISTS encounter_id UUID DEFAULT gen_random_uuid();

UPDATE emergency_visits
   SET encounter_id = gen_random_uuid()
 WHERE encounter_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emergency_visits_encounter_id_key'
  ) THEN
    ALTER TABLE emergency_visits
      ADD CONSTRAINT emergency_visits_encounter_id_key UNIQUE (encounter_id);
  END IF;
END $$;

-- CHECK constraints (current values per migrations 126 / 196 / 217).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emergency_visits_arrival_mode_check'
  ) THEN
    ALTER TABLE emergency_visits
      ADD CONSTRAINT emergency_visits_arrival_mode_check
      CHECK (arrival_mode IN (
        'walk_in', 'ambulance', 'air_ambulance', 'self_transport',
        'transfer_in', 'police', 'other'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emergency_visits_triage_priority_check'
  ) THEN
    ALTER TABLE emergency_visits
      ADD CONSTRAINT emergency_visits_triage_priority_check
      CHECK (triage_priority IS NULL OR triage_priority IN (
        'esi_1', 'esi_2', 'esi_3', 'esi_4', 'esi_5',
        'manchester_red', 'manchester_orange', 'manchester_yellow',
        'manchester_green', 'manchester_blue',
        'ctas_1', 'ctas_2', 'ctas_3', 'ctas_4', 'ctas_5',
        'ats_1', 'ats_2', 'ats_3', 'ats_4', 'ats_5',
        'unassigned'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emergency_visits_status_check'
  ) THEN
    ALTER TABLE emergency_visits
      ADD CONSTRAINT emergency_visits_status_check
      CHECK (status IN (
        'arriving', 'in_triage', 'awaiting_treatment', 'in_treatment',
        'awaiting_disposition', 'admitted', 'discharged', 'transferred',
        'left_against_advice', 'lwbs', 'expired', 'archived'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emergency_visits_disposition_check'
  ) THEN
    ALTER TABLE emergency_visits
      ADD CONSTRAINT emergency_visits_disposition_check
      CHECK (disposition IS NULL OR disposition IN (
        'discharged_home', 'admitted_ward', 'admitted_icu', 'admitted_hdu',
        'admitted', 'transferred_out', 'left_against_medical_advice', 'lwbs',
        'expired', 'observation', 'opd_followup', 'other'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ed_visits_tenant_status
  ON emergency_visits (tenant_id, status, arrival_at DESC);
CREATE INDEX IF NOT EXISTS idx_ed_visits_patient
  ON emergency_visits (tenant_id, patient_uid, arrival_at DESC)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ed_visits_priority
  ON emergency_visits (tenant_id, triage_priority, status)
  WHERE triage_priority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ed_visits_mlc
  ON emergency_visits (tenant_id, is_mlc, arrival_at DESC)
  WHERE is_mlc = true;
CREATE INDEX IF NOT EXISTS idx_ed_visits_open
  ON emergency_visits (tenant_id, arrival_at DESC)
  WHERE status NOT IN (
    'discharged', 'transferred', 'left_against_advice',
    'lwbs', 'expired', 'archived'
  );

-- ---------------------------------------------------------------------------
-- 2. triage_assessments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS triage_assessments (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  emergency_visit_id          INTEGER REFERENCES emergency_visits(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  assessment_kind             VARCHAR(20) NOT NULL DEFAULT 'esi'
    CHECK (assessment_kind IN ('esi', 'manchester', 'ctas', 'pat', 'australian', 'other')),
  assessed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessed_by_uid             UUID,
  level                       VARCHAR(40) NOT NULL,
  presenting_complaint        TEXT,
  vitals                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  pain_score                  INTEGER CHECK (pain_score IS NULL OR (pain_score >= 0 AND pain_score <= 10)),
  airway_concern              BOOLEAN NOT NULL DEFAULT false,
  breathing_concern           BOOLEAN NOT NULL DEFAULT false,
  circulation_concern         BOOLEAN NOT NULL DEFAULT false,
  red_flags                   TEXT[] NOT NULL DEFAULT '{}',
  ai_predicted_level          VARCHAR(40),
  ai_prediction_id            INTEGER,
  reassessment_due_at         TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triage_visit
  ON triage_assessments (emergency_visit_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_triage_tenant_kind
  ON triage_assessments (tenant_id, assessment_kind, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_triage_level
  ON triage_assessments (tenant_id, level, assessed_at DESC);

-- ---------------------------------------------------------------------------
-- 3. ambulance_requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ambulance_requests (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER,
  request_number              VARCHAR(80) NOT NULL,
  request_kind                VARCHAR(40) NOT NULL DEFAULT 'pickup'
    CHECK (request_kind IN (
      'pickup', 'transfer_out', 'inter_facility', 'home_to_hospital', 'air_evac', 'other'
    )),
  priority                    VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  caller_name                 VARCHAR(255),
  caller_phone                VARCHAR(40),
  patient_uid                 UUID,
  patient_name                VARCHAR(255),
  pickup_address              TEXT,
  pickup_geo_lat              NUMERIC(10, 6),
  pickup_geo_lng              NUMERIC(10, 6),
  destination                 VARCHAR(255),
  destination_facility_id     INTEGER,
  ambulance_unit_id           VARCHAR(80),
  driver_name                 VARCHAR(255),
  attendant_name              VARCHAR(255),
  status                      VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN (
      'requested', 'dispatched', 'en_route', 'on_scene',
      'returning', 'arrived', 'cancelled', 'completed', 'failed'
    )),
  requested_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at               TIMESTAMPTZ,
  on_scene_at                 TIMESTAMPTZ,
  arrived_at                  TIMESTAMPTZ,
  cancelled_reason            TEXT,
  presenting_complaint        TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, request_number)
);

CREATE INDEX IF NOT EXISTS idx_ambulance_tenant_status
  ON ambulance_requests (tenant_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ambulance_priority_open
  ON ambulance_requests (tenant_id, priority, requested_at)
  WHERE status IN ('requested', 'dispatched', 'en_route', 'on_scene');
CREATE INDEX IF NOT EXISTS idx_ambulance_patient
  ON ambulance_requests (tenant_id, patient_uid, requested_at DESC)
  WHERE patient_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. mlc_records (medico-legal case)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mlc_records (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  emergency_visit_id          INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  patient_uid                 UUID,
  mlc_number                  VARCHAR(80) NOT NULL,
  mlc_kind                    VARCHAR(40) NOT NULL
    CHECK (mlc_kind IN (
      'rta', 'assault', 'sexual_assault', 'poisoning', 'self_harm', 'attempted_suicide',
      'burn', 'electric_shock', 'drowning', 'animal_bite', 'snake_bite',
      'industrial_accident', 'firearm_injury', 'sharp_weapon_injury',
      'unknown_unconscious', 'pregnancy_related', 'other'
    )),
  reported_to_police_at       TIMESTAMPTZ,
  police_station              VARCHAR(255),
  police_report_number        VARCHAR(120),
  ipc_sections                TEXT[] NOT NULL DEFAULT '{}',
  brought_by_relation         VARCHAR(80),
  brought_by_name             VARCHAR(255),
  brought_by_phone            VARCHAR(40),
  incident_at                 TIMESTAMPTZ,
  incident_address            TEXT,
  history_summary             TEXT,
  examination_summary         TEXT,
  injuries                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_for_examination     BOOLEAN NOT NULL DEFAULT false,
  consent_for_disclosure      BOOLEAN NOT NULL DEFAULT false,
  certified_by_uid            UUID,
  certified_at                TIMESTAMPTZ,
  status                      VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending_certification', 'certified', 'closed', 'cancelled')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, mlc_number)
);

CREATE INDEX IF NOT EXISTS idx_mlc_tenant_status
  ON mlc_records (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mlc_visit
  ON mlc_records (emergency_visit_id) WHERE emergency_visit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mlc_kind
  ON mlc_records (tenant_id, mlc_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mlc_unreported
  ON mlc_records (tenant_id, created_at DESC)
  WHERE reported_to_police_at IS NULL AND status NOT IN ('cancelled', 'closed');

COMMIT;
