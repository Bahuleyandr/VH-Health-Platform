-- 279_medication_reconciliation.sql
--
-- Roadmap Pillar B / item B6 (docs/EPIC_LEVEL_ROADMAP.md) — formal
-- three-point medication reconciliation. Today only a discharge medication
-- draft reconciles pre-admission therapy informally; Epic treats med-rec as
-- a first-class transition-of-care step at ADMISSION (home meds → inpatient
-- orders), TRANSFER (ward/level changes), and DISCHARGE (take-home list
-- with continue/stop/change decisions per drug) — and auditors look for it.
--
--   * medication_reconciliations — one row per reconciliation episode
--     (admission/transfer/discharge), snapshotting the medication sources
--     that were on the table when it started.
--   * medication_reconciliation_items — one row per drug with the
--     clinician's explicit decision (continue/stop/change/new/hold) and
--     reason. Completion requires every item decided.
--
-- Canonical invariant: start/completion write clinical_timeline_events +
-- clinical_audit_events in the same transaction; per-item decisions write
-- clinical_audit_events.

BEGIN;

CREATE TABLE IF NOT EXISTS medication_reconciliations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid      UUID NOT NULL,
  patient_id       INTEGER,
  admission_id     INTEGER,
  encounter_id     UUID,
  rec_type         VARCHAR(20) NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  transfer_context VARCHAR(160),
  source_lists     JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes            TEXT,
  started_by       UUID,
  started_at       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_by     UUID,
  completed_at     TIMESTAMPTZ(6),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_medication_reconciliations_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_medication_reconciliations_type
    CHECK (rec_type IN ('admission', 'transfer', 'discharge')),
  CONSTRAINT chk_medication_reconciliations_status
    CHECK (status IN ('in_progress', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_medication_reconciliations_patient
  ON medication_reconciliations (tenant_id, patient_uid, rec_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_medication_reconciliations_admission
  ON medication_reconciliations (admission_id) WHERE admission_id IS NOT NULL;

-- One open reconciliation per patient/type/admission at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_medication_reconciliations_open
  ON medication_reconciliations (patient_uid, rec_type, COALESCE(admission_id, 0))
  WHERE status = 'in_progress';

CREATE TABLE IF NOT EXISTS medication_reconciliation_items (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reconciliation_id UUID NOT NULL REFERENCES medication_reconciliations(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  medication_name   VARCHAR(255) NOT NULL,
  dose              VARCHAR(120),
  frequency         VARCHAR(120),
  route             VARCHAR(40),
  source            VARCHAR(30) NOT NULL DEFAULT 'other',
  source_ref        VARCHAR(160),
  decision          VARCHAR(20),
  decision_reason   TEXT,
  new_instructions  TEXT,
  decided_by        UUID,
  decided_at        TIMESTAMPTZ(6),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_medication_reconciliation_items_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_medication_reconciliation_items_source
    CHECK (source IN ('home', 'inpatient', 'er', 'active_prescription', 'discharge_draft', 'other')),
  CONSTRAINT chk_medication_reconciliation_items_decision
    CHECK (decision IS NULL OR decision IN ('continue', 'stop', 'change', 'new', 'hold'))
);

CREATE INDEX IF NOT EXISTS idx_medication_reconciliation_items_rec
  ON medication_reconciliation_items (reconciliation_id, id);

-- Tenant isolation (same pattern as migrations 262/272/276).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['medication_reconciliations', 'medication_reconciliation_items'];
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
  'MEDICATION_RECONCILIATION_APPLIED',
  'medication_reconciliations',
  'medication_reconciliations',
  jsonb_build_object(
    'migration', '279_medication_reconciliation.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B6',
    'reason', 'Formal three-point med-rec (admission/transfer/discharge) with per-drug continue/stop/change/new/hold decisions and take-home list generation.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'MEDICATION_RECONCILIATION_APPLIED'
    AND resource = 'medication_reconciliations'
);

COMMIT;
