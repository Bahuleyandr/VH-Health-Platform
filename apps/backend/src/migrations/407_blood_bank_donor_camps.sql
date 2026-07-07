-- NL-6 N6-3 BB-B: thin donor camp records.

BEGIN;

CREATE TABLE IF NOT EXISTS donor_camps (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  camp_code VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  organizer VARCHAR(160),
  location TEXT,
  scheduled_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'planned',
  expected_donors INTEGER,
  collected_units INTEGER NOT NULL DEFAULT 0,
  contact_name VARCHAR(160),
  contact_phone VARCHAR(30),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_donor_camps_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT ux_donor_camps_code UNIQUE (tenant_id, camp_code),
  CONSTRAINT chk_donor_camps_status
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled'))
);

ALTER TABLE donation_events
  ADD COLUMN IF NOT EXISTS camp_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_donation_events_camp') THEN
    ALTER TABLE donation_events
      ADD CONSTRAINT fk_donation_events_camp
        FOREIGN KEY (camp_id) REFERENCES donor_camps(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_donor_camps_status_date
  ON donor_camps (tenant_id, status, scheduled_date DESC);

CREATE INDEX IF NOT EXISTS idx_donation_events_camp
  ON donation_events (tenant_id, camp_id, collected_at DESC)
  WHERE camp_id IS NOT NULL;

ALTER TABLE donor_camps ENABLE ROW LEVEL SECURITY;
ALTER TABLE donor_camps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON donor_camps;
CREATE POLICY tenant_isolation ON donor_camps
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
