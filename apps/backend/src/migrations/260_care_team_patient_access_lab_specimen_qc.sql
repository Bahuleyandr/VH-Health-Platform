-- Migration 260: Canonical care-team access + lab specimen/analyzer/QC.
--
-- This migration fills two foundation gaps without replacing existing
-- admission, appointment, lab_results, or investigation tables:
--
--   1. Care-team-backed patient access:
--      - care_teams
--      - care_team_members
--      - care_team_status_history
--      - patient_access_break_glass
--      - patient_access_audit_log
--
--   2. Lab pre/post-analytic traceability:
--      - lab_specimens
--      - lab_specimen_status_history
--      - lab_analyzers
--      - lab_analyzer_status_history
--      - lab_analyzer_qc_runs
--      - appointment_queues
--      - appointment_queue_status_history
--
-- Every new operational/PHI table is tenant-scoped and carries audit
-- fields. Status history exists where the state transition itself has
-- clinical or governance meaning.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. First-class OP appointment queues
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS appointment_queues (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id           INTEGER REFERENCES facilities(id) ON DELETE SET NULL,
  queue_date            DATE NOT NULL,
  queue_kind            VARCHAR(40) NOT NULL DEFAULT 'op'
    CHECK (queue_kind IN (
      'op', 'walk_in', 'department', 'doctor', 'emergency', 'lab', 'imaging', 'other'
    )),
  department_id         INTEGER,
  department_name       VARCHAR(120),
  doctor_id             INTEGER,
  doctor_uid            UUID,
  queue_label           VARCHAR(255),
  status                VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('draft', 'open', 'paused', 'closed', 'archived')),
  capacity              INTEGER,
  check_in_opens_at     TIMESTAMPTZ,
  check_in_closes_at    TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointment_queue_context
  ON appointment_queues (
    tenant_id,
    queue_date,
    queue_kind,
    COALESCE(facility_id, 0),
    COALESCE(department_id, 0),
    COALESCE(doctor_id, 0)
  )
  WHERE status IN ('draft', 'open', 'paused');
CREATE INDEX IF NOT EXISTS idx_appointment_queues_date_status
  ON appointment_queues (tenant_id, queue_date, status, queue_kind);
CREATE INDEX IF NOT EXISTS idx_appointment_queues_doctor_date
  ON appointment_queues (tenant_id, doctor_id, queue_date, status)
  WHERE doctor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointment_queues_department_date
  ON appointment_queues (tenant_id, department_id, queue_date, status)
  WHERE department_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointment_queue_status_history (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_queue_id  INTEGER NOT NULL REFERENCES appointment_queues(id) ON DELETE CASCADE,
  from_status           VARCHAR(20),
  to_status             VARCHAR(20) NOT NULL
    CHECK (to_status IN ('draft', 'open', 'paused', 'closed', 'archived')),
  reason                TEXT,
  changed_by            UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_queue_status_history_time
  ON appointment_queue_status_history (tenant_id, appointment_queue_id, created_at DESC);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS queue_id INTEGER REFERENCES appointment_queues(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_queue_id
  ON appointments (tenant_id, queue_id, appointment_date, status)
  WHERE queue_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1. Care-team-backed patient access
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS care_teams (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid           UUID NOT NULL,
  admission_id          INTEGER,
  appointment_id        INTEGER,
  team_kind             VARCHAR(40) NOT NULL DEFAULT 'longitudinal'
    CHECK (team_kind IN (
      'op', 'ip', 'er', 'icu', 'day_care', 'dialysis',
      'perioperative', 'longitudinal', 'other'
    )),
  display_name          VARCHAR(255),
  primary_department    VARCHAR(120),
  status                VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'closed', 'archived')),
  status_reason         TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_teams_tenant_patient_status
  ON care_teams (tenant_id, patient_uid, status, team_kind);
CREATE INDEX IF NOT EXISTS idx_care_teams_admission
  ON care_teams (tenant_id, admission_id, status)
  WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_care_teams_appointment
  ON care_teams (tenant_id, appointment_id, status)
  WHERE appointment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_care_team_context
  ON care_teams (
    tenant_id,
    patient_uid,
    COALESCE(admission_id, 0),
    COALESCE(appointment_id, 0),
    team_kind
  )
  WHERE status IN ('active', 'paused');

CREATE TABLE IF NOT EXISTS care_team_members (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  care_team_id          INTEGER NOT NULL REFERENCES care_teams(id) ON DELETE CASCADE,
  patient_uid           UUID NOT NULL,
  staff_uid             UUID,
  staff_id              INTEGER,
  staff_role            VARCHAR(80),
  member_name           VARCHAR(255),
  relationship_kind     VARCHAR(50) NOT NULL DEFAULT 'care_team'
    CHECK (relationship_kind IN (
      'primary_consultant', 'attending_doctor', 'covering_doctor',
      'resident', 'nurse', 'pharmacist', 'physiotherapist',
      'billing_counsellor', 'care_coordinator', 'diagnostics',
      'housekeeping', 'care_team', 'other'
    )),
  access_scope          JSONB NOT NULL DEFAULT '{}'::jsonb,
  break_glass_allowed   BOOLEAN NOT NULL DEFAULT false,
  active_from           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_until          TIMESTAMPTZ,
  status                VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended', 'ended')),
  notes                 TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_care_team_member_identity
    CHECK (staff_uid IS NOT NULL OR staff_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_care_team_members_team_status
  ON care_team_members (tenant_id, care_team_id, status, relationship_kind);
CREATE INDEX IF NOT EXISTS idx_care_team_members_patient_staff
  ON care_team_members (tenant_id, patient_uid, staff_uid, status)
  WHERE staff_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_care_team_members_staff_id
  ON care_team_members (tenant_id, staff_id, status)
  WHERE staff_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_care_team_member_role
  ON care_team_members (
    care_team_id,
    COALESCE(staff_uid, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(staff_id, 0),
    relationship_kind
  )
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS care_team_member_status_history (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  care_team_member_id   INTEGER NOT NULL REFERENCES care_team_members(id) ON DELETE CASCADE,
  care_team_id          INTEGER NOT NULL REFERENCES care_teams(id) ON DELETE CASCADE,
  from_status           VARCHAR(20),
  to_status             VARCHAR(20) NOT NULL
    CHECK (to_status IN ('active', 'inactive', 'suspended', 'ended')),
  reason                TEXT,
  changed_by            UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_team_member_status_history_time
  ON care_team_member_status_history (tenant_id, care_team_member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS care_team_status_history (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  care_team_id          INTEGER NOT NULL REFERENCES care_teams(id) ON DELETE CASCADE,
  from_status           VARCHAR(20),
  to_status             VARCHAR(20) NOT NULL
    CHECK (to_status IN ('active', 'paused', 'closed', 'archived')),
  reason                TEXT,
  changed_by            UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_team_status_history_team_time
  ON care_team_status_history (tenant_id, care_team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS patient_access_break_glass (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid           UUID NOT NULL,
  actor_uid             UUID NOT NULL,
  actor_role            VARCHAR(80),
  reason                TEXT NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ended', 'expired', 'revoked')),
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  ended_by              UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_break_glass_reason_minimum
    CHECK (char_length(btrim(reason)) >= 8),
  CONSTRAINT chk_break_glass_end_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_break_glass_active_patient
  ON patient_access_break_glass (tenant_id, patient_uid, actor_uid, expires_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_break_glass_actor_time
  ON patient_access_break_glass (tenant_id, actor_uid, started_at DESC);

CREATE TABLE IF NOT EXISTS patient_access_break_glass_status_history (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  break_glass_id        INTEGER NOT NULL REFERENCES patient_access_break_glass(id) ON DELETE CASCADE,
  patient_uid           UUID NOT NULL,
  actor_uid             UUID NOT NULL,
  from_status           VARCHAR(20),
  to_status             VARCHAR(20) NOT NULL
    CHECK (to_status IN ('active', 'ended', 'expired', 'revoked')),
  reason                TEXT,
  changed_by            UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_break_glass_status_history_time
  ON patient_access_break_glass_status_history (tenant_id, break_glass_id, created_at DESC);

CREATE TABLE IF NOT EXISTS patient_access_audit_log (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid           UUID NOT NULL,
  actor_uid             UUID,
  actor_role            VARCHAR(80),
  access_decision       VARCHAR(20) NOT NULL
    CHECK (access_decision IN ('allow', 'deny', 'break_glass')),
  access_source         VARCHAR(40) NOT NULL
    CHECK (access_source IN (
      'role', 'care_team', 'appointment', 'admission',
      'guardian', 'break_glass', 'system', 'unknown'
    )),
  reason                TEXT,
  route                 VARCHAR(255),
  action                VARCHAR(120),
  care_team_id          INTEGER REFERENCES care_teams(id) ON DELETE SET NULL,
  break_glass_id        INTEGER REFERENCES patient_access_break_glass(id) ON DELETE SET NULL,
  request_id            VARCHAR(120),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_access_audit_patient_time
  ON patient_access_audit_log (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_access_audit_actor_time
  ON patient_access_audit_log (tenant_id, actor_uid, created_at DESC)
  WHERE actor_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patient_access_audit_decision_time
  ON patient_access_audit_log (tenant_id, access_decision, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Lab specimen lifecycle, analyzer registry, and QC
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_specimens (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  specimen_uid          UUID NOT NULL DEFAULT gen_random_uuid(),
  patient_uid           UUID NOT NULL,
  booking_id            INTEGER,
  accession_number      VARCHAR(120) NOT NULL,
  specimen_type         VARCHAR(40) NOT NULL DEFAULT 'blood'
    CHECK (specimen_type IN (
      'blood', 'urine', 'stool', 'sputum', 'swab', 'tissue',
      'csf', 'fluid', 'semen', 'other'
    )),
  container_type        VARCHAR(80),
  collection_site       VARCHAR(120),
  priority              VARCHAR(20) NOT NULL DEFAULT 'routine'
    CHECK (priority IN ('routine', 'urgent', 'stat')),
  status                VARCHAR(30) NOT NULL DEFAULT 'ordered'
    CHECK (status IN (
      'ordered', 'collected', 'in_transit', 'received',
      'processing', 'rejected', 'disposed', 'cancelled'
    )),
  status_reason         TEXT,
  collected_at          TIMESTAMPTZ,
  collected_by          UUID,
  received_at           TIMESTAMPTZ,
  received_by           UUID,
  rejected_at           TIMESTAMPTZ,
  rejected_by           UUID,
  rejection_reason      TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, accession_number),
  UNIQUE (tenant_id, specimen_uid)
);

CREATE INDEX IF NOT EXISTS idx_lab_specimens_patient_time
  ON lab_specimens (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_specimens_booking
  ON lab_specimens (tenant_id, booking_id, status)
  WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_specimens_status_priority
  ON lab_specimens (tenant_id, status, priority, created_at DESC);

CREATE TABLE IF NOT EXISTS lab_specimen_status_history (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  specimen_id           INTEGER NOT NULL REFERENCES lab_specimens(id) ON DELETE CASCADE,
  from_status           VARCHAR(30),
  to_status             VARCHAR(30) NOT NULL
    CHECK (to_status IN (
      'ordered', 'collected', 'in_transit', 'received',
      'processing', 'rejected', 'disposed', 'cancelled'
    )),
  reason                TEXT,
  changed_by            UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_specimen_status_history_time
  ON lab_specimen_status_history (tenant_id, specimen_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lab_analyzers (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id           INTEGER REFERENCES facilities(id) ON DELETE SET NULL,
  location_id           INTEGER REFERENCES facility_locations(id) ON DELETE SET NULL,
  analyzer_code         VARCHAR(120) NOT NULL,
  display_name          VARCHAR(255) NOT NULL,
  manufacturer          VARCHAR(120),
  model                 VARCHAR(120),
  serial_number         VARCHAR(120),
  interface_kind        VARCHAR(40) NOT NULL DEFAULT 'manual'
    CHECK (interface_kind IN ('manual', 'hl7', 'astm', 'api', 'file_drop', 'other')),
  status                VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'maintenance', 'offline', 'retired')),
  last_qc_at            TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, analyzer_code)
);

CREATE INDEX IF NOT EXISTS idx_lab_analyzers_tenant_status
  ON lab_analyzers (tenant_id, status, analyzer_code);
CREATE INDEX IF NOT EXISTS idx_lab_analyzers_location
  ON lab_analyzers (tenant_id, facility_id, location_id, status)
  WHERE facility_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lab_analyzer_status_history (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  analyzer_id           INTEGER NOT NULL REFERENCES lab_analyzers(id) ON DELETE CASCADE,
  from_status           VARCHAR(30),
  to_status             VARCHAR(30) NOT NULL
    CHECK (to_status IN ('active', 'maintenance', 'offline', 'retired')),
  reason                TEXT,
  changed_by            UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_analyzer_status_history_time
  ON lab_analyzer_status_history (tenant_id, analyzer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lab_analyzer_qc_runs (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  analyzer_id           INTEGER NOT NULL REFERENCES lab_analyzers(id) ON DELETE CASCADE,
  qc_level              VARCHAR(40) NOT NULL DEFAULT 'normal'
    CHECK (qc_level IN ('low', 'normal', 'high', 'calibration', 'linearity', 'other')),
  qc_lot_number         VARCHAR(120),
  result_status         VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (result_status IN ('pending', 'passed', 'failed', 'warning')),
  measured_values       JSONB NOT NULL DEFAULT '{}'::jsonb,
  performed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  performed_by          UUID,
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           UUID,
  notes                 TEXT,
  raw_payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_qc_runs_analyzer_time
  ON lab_analyzer_qc_runs (tenant_id, analyzer_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_qc_runs_result_time
  ON lab_analyzer_qc_runs (tenant_id, result_status, performed_at DESC);

ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS specimen_id INTEGER REFERENCES lab_specimens(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS analyzer_id INTEGER REFERENCES lab_analyzers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qc_run_id INTEGER REFERENCES lab_analyzer_qc_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lab_results_specimen
  ON lab_results (tenant_id, specimen_id)
  WHERE specimen_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_results_analyzer
  ON lab_results (tenant_id, analyzer_id, received_at DESC)
  WHERE analyzer_id IS NOT NULL;

COMMIT;
