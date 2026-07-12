-- NL-13 P1f: cath-lab cases become bookable on the Scheduling 2.0 rails.
--
-- Link table between cath_lab_cases and resource_bookings (migration 285 +
-- 481). Cath rooms are ordinary bookable_resources rows (kind='room') that the
-- owner creates through the existing scheduling admin — this migration seeds
-- ZERO rooms on purpose (owner-decision inert slot). Emergency/STEMI cases
-- never book: the service layer rejects urgency='emergency' at the booking
-- boundary and surfaces them as soft-conflict indicators instead.
--
-- No column on cath_lab_cases is added or altered (P1 tables stay untouched);
-- the linkage lives entirely in this table. No append-only trigger here, so
-- the ON DELETE actions below stay legal (playbook §3).

CREATE TABLE IF NOT EXISTS cath_case_schedule_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  resource_booking_id INTEGER NOT NULL REFERENCES resource_bookings(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES bookable_resources(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  linked_by UUID,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ(6),
  cancel_reason TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_case_schedule_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_case_schedule_links_status_check
    CHECK (status IN ('active', 'cancelled'))
);

-- One live booking per case, one live case per booking.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cath_case_schedule_links_active_case
  ON cath_case_schedule_links (tenant_id, case_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cath_case_schedule_links_active_booking
  ON cath_case_schedule_links (tenant_id, resource_booking_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cath_case_schedule_links_resource
  ON cath_case_schedule_links (tenant_id, resource_id, created_at DESC);

ALTER TABLE cath_case_schedule_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_case_schedule_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_case_schedule_links;
CREATE POLICY tenant_isolation ON cath_case_schedule_links
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
