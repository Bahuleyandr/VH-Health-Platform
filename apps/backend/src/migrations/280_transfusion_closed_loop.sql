-- 280_transfusion_closed_loop.sql
--
-- Roadmap Pillar B / item B5 (docs/EPIC_LEVEL_ROADMAP.md) — close the
-- transfusion loop. blood_requests tracked request→crossmatch→issue→
-- transfused as bare status flips: no unit traceability (which bag went
-- into which patient), no two-person bedside verification, and reactions
-- were free text appended to notes. This migration adds the missing
-- substrate:
--
--   * blood_units                — physical unit registry (unit number from
--     the supplying blood bank label, group/component, expiry, status
--     lifecycle) so every transfusion traces to a specific bag.
--   * blood_requests.crossmatched_unit_id / transfusion_started_at — the
--     request pins the exact unit at crossmatch; start time recorded for
--     the bedside flow.
--   * transfusion_verifications  — two-person bedside check (first/second
--     verifier must differ): scan unit + scan wristband, ABO/Rh
--     compatibility + expiry verdicts, override-with-reason audited.
--   * transfusion_reactions      — structured hemovigilance reporting
--     (type, severity, vitals snapshot, intervention, outcome) replacing
--     the notes append.
--
-- Canonical invariant: crossmatch/verification/start/complete/reaction all
-- emit clinical_timeline_events + clinical_audit_events in-transaction
-- (transfusionSafetyService).

BEGIN;

CREATE TABLE IF NOT EXISTS blood_units (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  unit_number       VARCHAR(60) NOT NULL,
  blood_group       VARCHAR(5) NOT NULL,
  component         VARCHAR(30) NOT NULL DEFAULT 'prbc',
  status            VARCHAR(20) NOT NULL DEFAULT 'available',
  volume_ml         INTEGER,
  collected_date    DATE,
  expiry_date       DATE NOT NULL,
  donor_ref         VARCHAR(80),
  source_blood_bank VARCHAR(160),
  request_id        INTEGER REFERENCES blood_requests(id) ON DELETE SET NULL,
  registered_by     UUID,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_blood_units_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_blood_units_number UNIQUE (tenant_id, unit_number),
  CONSTRAINT chk_blood_units_group
    CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  CONSTRAINT chk_blood_units_component
    CHECK (component IN ('whole_blood', 'prbc', 'ffp', 'platelets', 'cryoprecipitate')),
  CONSTRAINT chk_blood_units_status
    CHECK (status IN ('available', 'reserved', 'crossmatched', 'issued', 'transfused',
                      'discarded', 'expired', 'returned'))
);

CREATE INDEX IF NOT EXISTS idx_blood_units_stock
  ON blood_units (tenant_id, status, blood_group, component, expiry_date);

ALTER TABLE blood_requests
  ADD COLUMN IF NOT EXISTS crossmatched_unit_id INTEGER REFERENCES blood_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transfusion_started_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS transfusion_started_by UUID;

CREATE TABLE IF NOT EXISTS transfusion_verifications (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  request_id          INTEGER NOT NULL REFERENCES blood_requests(id) ON DELETE CASCADE,
  unit_id             INTEGER REFERENCES blood_units(id) ON DELETE SET NULL,
  verifier_role       VARCHAR(10) NOT NULL,
  verified_by         UUID NOT NULL,
  scanned_unit_number VARCHAR(60),
  scanned_patient_uid UUID,
  unit_match          BOOLEAN NOT NULL DEFAULT false,
  patient_match       BOOLEAN NOT NULL DEFAULT false,
  group_compatible    BOOLEAN NOT NULL DEFAULT false,
  expiry_ok           BOOLEAN NOT NULL DEFAULT false,
  all_checks_passed   BOOLEAN NOT NULL DEFAULT false,
  override_reason     TEXT,
  verified_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_transfusion_verifications_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_transfusion_verifications_role CHECK (verifier_role IN ('first', 'second')),
  CONSTRAINT uq_transfusion_verifications_role UNIQUE (request_id, verifier_role)
);

CREATE TABLE IF NOT EXISTS transfusion_reactions (
  id                      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id               UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  request_id              INTEGER NOT NULL REFERENCES blood_requests(id) ON DELETE CASCADE,
  unit_id                 INTEGER REFERENCES blood_units(id) ON DELETE SET NULL,
  reaction_type           VARCHAR(30) NOT NULL,
  severity                VARCHAR(20) NOT NULL,
  onset_at                TIMESTAMPTZ(6),
  symptoms                TEXT,
  vitals                  JSONB,
  intervention            TEXT,
  transfusion_stopped     BOOLEAN NOT NULL DEFAULT true,
  outcome                 VARCHAR(160),
  hemovigilance_reported  BOOLEAN NOT NULL DEFAULT false,
  reported_by             UUID,
  reported_at             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_transfusion_reactions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_transfusion_reactions_type
    CHECK (reaction_type IN ('febrile', 'allergic_mild', 'anaphylaxis', 'acute_hemolytic',
                             'delayed_hemolytic', 'taco', 'trali', 'septic', 'hypotensive', 'other')),
  CONSTRAINT chk_transfusion_reactions_severity
    CHECK (severity IN ('mild', 'moderate', 'severe', 'life_threatening'))
);

CREATE INDEX IF NOT EXISTS idx_transfusion_reactions_request
  ON transfusion_reactions (request_id, reported_at DESC);

-- Tenant isolation (262/272 pattern).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['blood_units', 'transfusion_verifications', 'transfusion_reactions'];
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
  'TRANSFUSION_CLOSED_LOOP_APPLIED',
  'blood_units',
  'blood_units',
  jsonb_build_object(
    'migration', '280_transfusion_closed_loop.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B5',
    'reason', 'Unit traceability, two-person bedside verification with barcode checks, and structured hemovigilance reaction reporting.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TRANSFUSION_CLOSED_LOOP_APPLIED'
    AND resource = 'blood_units'
);

COMMIT;
