-- Future-proof foundations: clinical AI governance, event outbox, data rights,
-- and downtime snapshots. Kept additive/idempotent for existing deployments.

CREATE TABLE IF NOT EXISTS clinical_notes (
  id SERIAL PRIMARY KEY,
  encounter_id UUID,
  patient_uid UUID NOT NULL,
  author_uid UUID,
  author_role VARCHAR(50),
  note_type VARCHAR(50) NOT NULL,
  title TEXT,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  parent_note_id INTEGER REFERENCES clinical_notes(id) ON DELETE SET NULL,
  is_addendum BOOLEAN NOT NULL DEFAULT false,
  is_signed BOOLEAN NOT NULL DEFAULT false,
  signed_at TIMESTAMPTZ,
  signed_by UUID,
  ai_generation_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE clinical_notes
  ADD COLUMN IF NOT EXISTS encounter_id UUID,
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS author_uid UUID,
  ADD COLUMN IF NOT EXISTS author_role VARCHAR(50),
  ADD COLUMN IF NOT EXISTS note_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS content JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS procedure_name TEXT,
  ADD COLUMN IF NOT EXISTS performed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS performed_by UUID,
  ADD COLUMN IF NOT EXISTS author_id UUID,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS complications TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_note_id INTEGER,
  ADD COLUMN IF NOT EXISTS is_addendum BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_signed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signed_by UUID,
  ADD COLUMN IF NOT EXISTS ai_generation_id INTEGER,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_clinical_notes_patient_created
  ON clinical_notes(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_encounter
  ON clinical_notes(encounter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_notes_type
  ON clinical_notes(note_type);

CREATE TABLE IF NOT EXISTS clinical_orders (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(80) UNIQUE NOT NULL,
  encounter_id UUID,
  patient_uid UUID NOT NULL,
  order_type VARCHAR(50) NOT NULL,
  priority VARCHAR(50) NOT NULL DEFAULT 'routine',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(50) NOT NULL DEFAULT 'ordered',
  ordered_by UUID,
  verified_by UUID,
  verified_at TIMESTAMPTZ,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE clinical_orders
  ADD COLUMN IF NOT EXISTS order_number VARCHAR(80),
  ADD COLUMN IF NOT EXISTS encounter_id UUID,
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'routine',
  ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'ordered',
  ADD COLUMN IF NOT EXISTS ordered_by UUID,
  ADD COLUMN IF NOT EXISTS verified_by UUID,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_clinical_orders_patient_created
  ON clinical_orders(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_orders_encounter
  ON clinical_orders(encounter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_orders_status
  ON clinical_orders(status);

CREATE TABLE IF NOT EXISTS nurse_handovers (
  id SERIAL PRIMARY KEY,
  patient_uid UUID NOT NULL,
  ward VARCHAR(255),
  bed_number VARCHAR(50),
  outgoing_nurse UUID,
  incoming_nurse UUID,
  shift VARCHAR(50),
  patient_summary TEXT NOT NULL DEFAULT '',
  summary TEXT,
  active_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  medications_due JSONB NOT NULL DEFAULT '[]'::jsonb,
  alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
  special_instructions TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE nurse_handovers
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS ward VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bed_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS outgoing_nurse UUID,
  ADD COLUMN IF NOT EXISTS incoming_nurse UUID,
  ADD COLUMN IF NOT EXISTS shift VARCHAR(50),
  ADD COLUMN IF NOT EXISTS patient_summary TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS active_issues JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pending_tasks JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS medications_due JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS alerts JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS special_instructions TEXT,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_nurse_handovers_patient_created
  ON nurse_handovers(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nurse_handovers_incoming_pending
  ON nurse_handovers(incoming_nurse, acknowledged, created_at DESC);

CREATE TABLE IF NOT EXISTS vitals_chart (
  id SERIAL PRIMARY KEY,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  heart_rate NUMERIC(6,2),
  systolic_bp NUMERIC(6,2),
  diastolic_bp NUMERIC(6,2),
  temperature NUMERIC(5,2),
  spo2 NUMERIC(5,2),
  respiratory_rate NUMERIC(5,2),
  blood_glucose NUMERIC(8,2),
  pain_score NUMERIC(4,1),
  weight_kg NUMERIC(6,2),
  height_cm NUMERIC(6,2),
  gcs_score INTEGER,
  consciousness VARCHAR(10),
  recorded_by UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS encounter_id UUID,
  ADD COLUMN IF NOT EXISTS heart_rate NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS systolic_bp NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS diastolic_bp NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS temperature NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS spo2 NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS respiratory_rate NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS blood_glucose NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS pain_score NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS gcs_score INTEGER,
  ADD COLUMN IF NOT EXISTS consciousness VARCHAR(10),
  ADD COLUMN IF NOT EXISTS recorded_by UUID,
  ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_vitals_chart_patient_recorded
  ON vitals_chart(patient_uid, recorded_at DESC);

CREATE TABLE IF NOT EXISTS news2_scores (
  id SERIAL PRIMARY KEY,
  patient_uid UUID NOT NULL,
  respiration_rate NUMERIC(6,2),
  spo2 NUMERIC(6,2),
  spo2_scale INTEGER NOT NULL DEFAULT 1,
  supplemental_o2 BOOLEAN NOT NULL DEFAULT false,
  temperature NUMERIC(5,2),
  systolic_bp NUMERIC(6,2),
  heart_rate NUMERIC(6,2),
  consciousness VARCHAR(10),
  total_score INTEGER NOT NULL DEFAULT 0,
  clinical_risk VARCHAR(50),
  escalation_action TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE news2_scores
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS respiration_rate NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS spo2 NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS spo2_scale INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS supplemental_o2 BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS temperature NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS systolic_bp NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS heart_rate NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS consciousness VARCHAR(10),
  ADD COLUMN IF NOT EXISTS total_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clinical_risk VARCHAR(50),
  ADD COLUMN IF NOT EXISTS escalation_action TEXT,
  ADD COLUMN IF NOT EXISTS recorded_by UUID,
  ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_news2_scores_patient_recorded
  ON news2_scores(patient_uid, recorded_at DESC);

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS reason_for_admission TEXT,
  ADD COLUMN IF NOT EXISTS discharge_disposition TEXT;

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS investigation_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS results JSONB,
  ADD COLUMN IF NOT EXISTS result_summary TEXT,
  ADD COLUMN IF NOT EXISTS interpretation TEXT,
  ADD COLUMN IF NOT EXISTS conclusion TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE investigations
SET patient_uid = uid
WHERE patient_uid IS NULL AND uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_investigations_patient_uid_created
  ON investigations(patient_uid, created_at DESC);

ALTER TABLE allergies
  ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ DEFAULT NOW();

UPDATE allergies
SET recorded_at = created_at
WHERE recorded_at IS NULL AND created_at IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.referrals') IS NOT NULL THEN
    ALTER TABLE referrals
      ADD COLUMN IF NOT EXISTS patient_uid UUID,
      ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'ROUTINE',
      ADD COLUMN IF NOT EXISTS referring_doctor UUID,
      ADD COLUMN IF NOT EXISTS requester_id UUID,
      ADD COLUMN IF NOT EXISTS referred_to_doctor UUID,
      ADD COLUMN IF NOT EXISTS performer_id UUID,
      ADD COLUMN IF NOT EXISTS referred_to_department TEXT,
      ADD COLUMN IF NOT EXISTS reason TEXT,
      ADD COLUMN IF NOT EXISTS clinical_notes TEXT,
      ADD COLUMN IF NOT EXISTS notes TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

ALTER TABLE patient_consents
  ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS granted_by VARCHAR(100),
  ADD COLUMN IF NOT EXISTS revoked_by VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS data_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS version VARCHAR(30) NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) NOT NULL DEFAULT 'portal',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_patient_consents_patient_created
  ON patient_consents(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_consents_type_status
  ON patient_consents(consent_type, status);

CREATE TABLE IF NOT EXISTS patient_data_rights_requests (
  id SERIAL PRIMARY KEY,
  patient_uid UUID NOT NULL,
  request_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'submitted',
  requested_by UUID,
  request_source VARCHAR(50) NOT NULL DEFAULT 'portal',
  due_at TIMESTAMPTZ,
  notes TEXT,
  resolution JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_rights_patient_created
  ON patient_data_rights_requests(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_rights_status_due
  ON patient_data_rights_requests(status, due_at);

CREATE TABLE IF NOT EXISTS event_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(120) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id VARCHAR(120),
  patient_uid UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_status_available
  ON event_outbox(status, available_at, id);
CREATE INDEX IF NOT EXISTS idx_event_outbox_patient_created
  ON event_outbox(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_outbox_type_created
  ON event_outbox(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_generations (
  id SERIAL PRIMARY KEY,
  patient_uid UUID,
  admission_id INTEGER,
  task_type VARCHAR(80) NOT NULL,
  provider VARCHAR(80) NOT NULL DEFAULT 'template',
  model VARCHAR(160),
  prompt_version VARCHAR(40) NOT NULL DEFAULT 'clinical-doc-v1',
  source_hash VARCHAR(128),
  status VARCHAR(40) NOT NULL DEFAULT 'draft',
  used_ai BOOLEAN NOT NULL DEFAULT false,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by UUID,
  reviewed_by UUID,
  signed_note_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_patient_created
  ON clinical_ai_generations(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_admission
  ON clinical_ai_generations(admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_task
  ON clinical_ai_generations(task_type, created_at DESC);

CREATE TABLE IF NOT EXISTS downtime_snapshots (
  id SERIAL PRIMARY KEY,
  patient_uid UUID NOT NULL,
  scope VARCHAR(80) NOT NULL DEFAULT 'patient_chart',
  generated_by UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_downtime_snapshots_patient_created
  ON downtime_snapshots(patient_uid, created_at DESC);
