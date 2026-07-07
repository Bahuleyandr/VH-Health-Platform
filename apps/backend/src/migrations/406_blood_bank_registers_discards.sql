-- NL-6 N6-3 BB-B: discard chain evidence and statutory register export ledger.

BEGIN;

CREATE TABLE IF NOT EXISTS blood_unit_discard_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  unit_id INTEGER NOT NULL,
  donor_id INTEGER,
  donation_event_id INTEGER,
  tti_test_id INTEGER,
  event_type VARCHAR(30) NOT NULL,
  reason_code VARCHAR(80) NOT NULL,
  reason_text TEXT NOT NULL,
  reversible BOOLEAN NOT NULL DEFAULT true,
  performed_by UUID,
  performed_by_role VARCHAR(60),
  performed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_blood_unit_discards_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_blood_unit_discards_unit
    FOREIGN KEY (unit_id) REFERENCES blood_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_blood_unit_discards_donor
    FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE SET NULL,
  CONSTRAINT fk_blood_unit_discards_donation_event
    FOREIGN KEY (donation_event_id) REFERENCES donation_events(id) ON DELETE SET NULL,
  CONSTRAINT fk_blood_unit_discards_tti_test
    FOREIGN KEY (tti_test_id) REFERENCES tti_tests(id) ON DELETE SET NULL,
  CONSTRAINT chk_blood_unit_discards_event
    CHECK (event_type IN ('quarantined', 'discard_confirmed', 'quarantine_released'))
);

CREATE INDEX IF NOT EXISTS idx_blood_unit_discards_unit_time
  ON blood_unit_discard_events (tenant_id, unit_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_blood_unit_discards_reason
  ON blood_unit_discard_events (tenant_id, event_type, reason_code, performed_at DESC);

CREATE TABLE IF NOT EXISTS blood_bank_register_exports (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  register_type VARCHAR(40) NOT NULL,
  export_format VARCHAR(20) NOT NULL,
  format_pending BOOLEAN NOT NULL DEFAULT true,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count INTEGER NOT NULL DEFAULT 0,
  generated_by UUID,
  generated_by_role VARCHAR(60),
  generated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_blood_bank_register_exports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_blood_bank_register_type
    CHECK (register_type IN ('donor', 'collection', 'tti', 'component_preparation', 'deferral', 'discard')),
  CONSTRAINT chk_blood_bank_register_format
    CHECK (export_format IN ('json', 'xlsx', 'pdf'))
);

CREATE INDEX IF NOT EXISTS idx_blood_bank_register_exports_type_time
  ON blood_bank_register_exports (tenant_id, register_type, generated_at DESC);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['blood_unit_discard_events', 'blood_bank_register_exports'];
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

COMMIT;
