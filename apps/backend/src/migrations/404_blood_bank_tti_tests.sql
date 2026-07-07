-- NL-6 N6-3 BB-B: transfusion-transmissible infection testing workflow.

BEGIN;

ALTER TABLE donation_events
  ADD COLUMN IF NOT EXISTS tti_status VARCHAR(30) NOT NULL DEFAULT 'not_tested',
  ADD COLUMN IF NOT EXISTS last_tti_test_id INTEGER;

ALTER TABLE donation_events
  DROP CONSTRAINT IF EXISTS chk_donation_events_tti_status;
ALTER TABLE donation_events
  ADD CONSTRAINT chk_donation_events_tti_status
    CHECK (tti_status IN ('not_tested', 'pending', 'non_reactive', 'reactive', 'indeterminate', 'repeat_required'));

CREATE TABLE IF NOT EXISTS tti_tests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  donation_event_id INTEGER NOT NULL,
  donor_id INTEGER NOT NULL,
  panel_code VARCHAR(40) NOT NULL DEFAULT 'standard_tti',
  sample_identifier VARCHAR(80),
  result_hiv VARCHAR(20) NOT NULL DEFAULT 'not_tested',
  result_hbsag VARCHAR(20) NOT NULL DEFAULT 'not_tested',
  result_hcv VARCHAR(20) NOT NULL DEFAULT 'not_tested',
  result_syphilis VARCHAR(20) NOT NULL DEFAULT 'not_tested',
  result_malaria VARCHAR(20) NOT NULL DEFAULT 'not_tested',
  results JSONB NOT NULL DEFAULT '{}'::jsonb,
  overall_result VARCHAR(20) NOT NULL DEFAULT 'pending',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  repeat_parent_id INTEGER,
  repeat_sequence INTEGER NOT NULL DEFAULT 1,
  tested_by UUID,
  tested_at TIMESTAMPTZ(6),
  approved_by UUID,
  approved_by_role VARCHAR(60),
  approved_at TIMESTAMPTZ(6),
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_tti_tests_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_tti_tests_donation_event
    FOREIGN KEY (donation_event_id) REFERENCES donation_events(id) ON DELETE CASCADE,
  CONSTRAINT fk_tti_tests_donor
    FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
  CONSTRAINT fk_tti_tests_repeat_parent
    FOREIGN KEY (repeat_parent_id) REFERENCES tti_tests(id) ON DELETE SET NULL,
  CONSTRAINT chk_tti_tests_result_hiv
    CHECK (result_hiv IN ('not_tested', 'non_reactive', 'reactive', 'indeterminate')),
  CONSTRAINT chk_tti_tests_result_hbsag
    CHECK (result_hbsag IN ('not_tested', 'non_reactive', 'reactive', 'indeterminate')),
  CONSTRAINT chk_tti_tests_result_hcv
    CHECK (result_hcv IN ('not_tested', 'non_reactive', 'reactive', 'indeterminate')),
  CONSTRAINT chk_tti_tests_result_syphilis
    CHECK (result_syphilis IN ('not_tested', 'non_reactive', 'reactive', 'indeterminate')),
  CONSTRAINT chk_tti_tests_result_malaria
    CHECK (result_malaria IN ('not_tested', 'non_reactive', 'reactive', 'indeterminate')),
  CONSTRAINT chk_tti_tests_overall
    CHECK (overall_result IN ('pending', 'non_reactive', 'reactive', 'indeterminate')),
  CONSTRAINT chk_tti_tests_status
    CHECK (status IN ('pending', 'approved', 'repeat_required', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tti_tests_donation_repeat
  ON tti_tests (tenant_id, donation_event_id, repeat_sequence);

CREATE INDEX IF NOT EXISTS idx_tti_tests_donor_time
  ON tti_tests (tenant_id, donor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tti_tests_status
  ON tti_tests (tenant_id, status, overall_result, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_donation_events_last_tti_test'
  ) THEN
    ALTER TABLE donation_events
      ADD CONSTRAINT fk_donation_events_last_tti_test
        FOREIGN KEY (last_tti_test_id) REFERENCES tti_tests(id) ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE tti_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tti_tests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tti_tests;
CREATE POLICY tenant_isolation ON tti_tests
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
  );

COMMIT;
