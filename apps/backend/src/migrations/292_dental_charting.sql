-- 292_dental_charting.sql
--
-- Roadmap Pillar D / item D7 — dental depth (greenfield; nothing dental
-- existed beyond service_catalog rows). Tooth-level longitudinal charting
-- on FDI notation + a procedure workflow that closes the loop back to the
-- finding it treats:
--
--   * dental_tooth_findings — per-tooth/per-surface findings (caries,
--     restorations, mobility, ...) with active/resolved lifecycle.
--   * dental_procedures     — planned → in_progress → completed|cancelled;
--     completing a procedure auto-resolves the finding it treats.
--
-- FDI tooth numbering (11-48 permanent, 51-85 deciduous) is validated in
-- the service (pure helper, unit-tested) AND by CHECK here.

BEGIN;

CREATE TABLE IF NOT EXISTS dental_tooth_findings (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid   UUID NOT NULL,
  tooth_fdi     VARCHAR(2) NOT NULL,
  surface       VARCHAR(10),
  finding       VARCHAR(24) NOT NULL,
  severity      VARCHAR(10),
  status        VARCHAR(12) NOT NULL DEFAULT 'active',
  noted_by      UUID,
  recorded_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at   TIMESTAMPTZ(6),
  resolved_by_procedure_id INTEGER,
  resolution_note TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dental_tooth_findings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_dental_tooth_findings_fdi CHECK (
    tooth_fdi ~ '^[1-4][1-8]$' OR tooth_fdi ~ '^[5-8][1-5]$'
  ),
  CONSTRAINT chk_dental_tooth_findings_surface CHECK (
    surface IS NULL OR surface IN ('mesial', 'distal', 'occlusal', 'buccal', 'lingual', 'palatal', 'incisal', 'cervical', 'whole')
  ),
  CONSTRAINT chk_dental_tooth_findings_finding CHECK (finding IN (
    'caries', 'filling', 'crown', 'bridge_pontic', 'implant', 'missing',
    'root_canal_treated', 'fracture', 'mobility_grade_1', 'mobility_grade_2',
    'mobility_grade_3', 'periapical_lesion', 'impacted', 'attrition',
    'abrasion', 'erosion', 'gingival_recession', 'calculus', 'other'
  )),
  CONSTRAINT chk_dental_tooth_findings_status CHECK (status IN ('active', 'resolved', 'entered_in_error'))
);

CREATE INDEX IF NOT EXISTS idx_dental_tooth_findings_patient
  ON dental_tooth_findings (patient_uid, status, tooth_fdi);

CREATE TABLE IF NOT EXISTS dental_procedures (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid    UUID NOT NULL,
  tooth_fdi      VARCHAR(2),
  surface        VARCHAR(10),
  finding_id     INTEGER REFERENCES dental_tooth_findings(id) ON DELETE SET NULL,
  procedure_name VARCHAR(200) NOT NULL,
  procedure_code VARCHAR(40),
  status         VARCHAR(12) NOT NULL DEFAULT 'planned',
  anesthesia     VARCHAR(120),
  materials      VARCHAR(200),
  performed_by   UUID,
  performed_at   TIMESTAMPTZ(6),
  cancelled_reason TEXT,
  notes          TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dental_procedures_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_dental_procedures_fdi CHECK (
    tooth_fdi IS NULL OR tooth_fdi ~ '^[1-4][1-8]$' OR tooth_fdi ~ '^[5-8][1-5]$'
  ),
  CONSTRAINT chk_dental_procedures_status
    CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_dental_procedures_patient
  ON dental_procedures (patient_uid, status);

-- Cross-FK added after both tables exist (finding → resolving procedure).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_dental_findings_resolved_by'
  ) THEN
    ALTER TABLE dental_tooth_findings
      ADD CONSTRAINT fk_dental_findings_resolved_by
      FOREIGN KEY (resolved_by_procedure_id) REFERENCES dental_procedures(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- Tenant isolation (262/272 pattern) — both tables are PHI.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['dental_tooth_findings', 'dental_procedures'];
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
  'DENTAL_CHARTING_APPLIED',
  'dental_tooth_findings',
  'dental_tooth_findings',
  jsonb_build_object(
    'migration', '292_dental_charting.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D7',
    'reason', 'FDI tooth-level findings with active/resolved lifecycle + procedure workflow that auto-resolves the finding it treats.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'DENTAL_CHARTING_APPLIED'
    AND resource = 'dental_tooth_findings'
);

COMMIT;
