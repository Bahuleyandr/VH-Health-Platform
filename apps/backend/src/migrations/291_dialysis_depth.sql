-- 291_dialysis_depth.sql
--
-- Roadmap Pillar D / item D7 — dialysis depth. The Sprint-22 unit covers
-- roster/access/sessions/intra-obs/serology; this adds the three gaps the
-- roadmap called out:
--
--   * dialysis_prescriptions    — the standing HD/PD order (dialysate
--                                 composition, flows, anticoagulation,
--                                 UF limits). One ACTIVE per patient;
--                                 new prescriptions supersede in-tx.
--                                 Sessions inherit prescription params.
--   * machine ingestion         — provenance columns on dialysis_intra_obs
--                                 (source staff|device + source_device);
--                                 raw machine payloads persist to the B3
--                                 lab_interface_messages inbox (replayable)
--                                 exactly like C5 monitor vitals.
--   * dialysis_session_events   — structured intra-dialytic complications
--                                 (typed, severity, intervention) replacing
--                                 notes-append; severe events also set the
--                                 session boolean flags for adequacy
--                                 reporting continuity.

BEGIN;

CREATE TABLE IF NOT EXISTS dialysis_prescriptions (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  dialysis_patient_id   INTEGER NOT NULL REFERENCES dialysis_patients(id) ON DELETE CASCADE,
  modality              VARCHAR(10) NOT NULL DEFAULT 'hd',
  sessions_per_week     INTEGER NOT NULL DEFAULT 3,
  duration_minutes      INTEGER NOT NULL DEFAULT 240,
  dialyser              VARCHAR(80),
  dialysate_k_mmol      NUMERIC(4, 1),
  dialysate_ca_mmol     NUMERIC(4, 2),
  dialysate_na_mmol     NUMERIC(5, 1),
  dialysate_hco3_mmol   NUMERIC(4, 1),
  blood_flow_ml_min     INTEGER,
  dialysate_flow_ml_min INTEGER,
  target_dry_weight_kg  NUMERIC(5, 1),
  max_uf_ml_per_session INTEGER,
  anticoag              VARCHAR(40) NOT NULL DEFAULT 'heparin',
  anticoag_loading      VARCHAR(60),
  anticoag_maintenance  VARCHAR(60),
  status                VARCHAR(12) NOT NULL DEFAULT 'active',
  prescribed_by         UUID,
  valid_from            DATE NOT NULL DEFAULT CURRENT_DATE,
  superseded_at         TIMESTAMPTZ(6),
  notes                 TEXT,
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dialysis_prescriptions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_dialysis_prescriptions_status CHECK (status IN ('active', 'superseded')),
  CONSTRAINT chk_dialysis_prescriptions_modality
    CHECK (modality IN ('hd', 'hdf', 'pd_capd', 'pd_apd', 'crrt', 'sled')),
  CONSTRAINT chk_dialysis_prescriptions_freq CHECK (sessions_per_week BETWEEN 1 AND 7),
  CONSTRAINT chk_dialysis_prescriptions_duration CHECK (duration_minutes BETWEEN 30 AND 720)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dialysis_prescriptions_active
  ON dialysis_prescriptions (dialysis_patient_id)
  WHERE status = 'active';

-- Sessions inherit / point back to the prescription they ran under.
ALTER TABLE dialysis_sessions
  ADD COLUMN IF NOT EXISTS prescription_id INTEGER REFERENCES dialysis_prescriptions(id) ON DELETE SET NULL;

-- Machine-data provenance (C5 pattern: staff|device + device code).
ALTER TABLE dialysis_intra_obs
  ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'staff';
ALTER TABLE dialysis_intra_obs
  ADD COLUMN IF NOT EXISTS source_device VARCHAR(80);

CREATE TABLE IF NOT EXISTS dialysis_session_events (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  session_id      INTEGER NOT NULL REFERENCES dialysis_sessions(id) ON DELETE CASCADE,
  event_type      VARCHAR(20) NOT NULL,
  severity        VARCHAR(10) NOT NULL DEFAULT 'mild',
  occurred_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  bp_systolic     INTEGER,
  bp_diastolic    INTEGER,
  intervention    VARCHAR(200),
  intervention_dose VARCHAR(80),
  resolved        BOOLEAN NOT NULL DEFAULT false,
  recorded_by     UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dialysis_session_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_dialysis_session_events_type CHECK (event_type IN (
    'hypotension', 'cramps', 'clotting', 'bleeding', 'access_issue',
    'fever_rigors', 'hypoglycemia', 'arrhythmia', 'air_embolism_alarm', 'other'
  )),
  CONSTRAINT chk_dialysis_session_events_severity CHECK (severity IN ('mild', 'moderate', 'severe'))
);

CREATE INDEX IF NOT EXISTS idx_dialysis_session_events_session
  ON dialysis_session_events (session_id, occurred_at);

-- Tenant isolation (262/272 pattern) — prescriptions + events are PHI.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['dialysis_prescriptions', 'dialysis_session_events'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
    $f$, t);
  END LOOP;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'DIALYSIS_DEPTH_APPLIED',
  'dialysis_prescriptions',
  'dialysis_prescriptions',
  jsonb_build_object(
    'migration', '291_dialysis_depth.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D7',
    'reason', 'Dialysis prescriptions (one active per patient, sessions inherit), machine-data provenance on intra-obs + inbox-backed ingestion, structured intra-dialytic complication events.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'DIALYSIS_DEPTH_APPLIED'
    AND resource = 'dialysis_prescriptions'
);

COMMIT;
