-- NL-13 P6: transplant waitlist status history.

CREATE TABLE IF NOT EXISTS transplant_waitlist_status_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  candidate_id BIGINT NOT NULL,
  status VARCHAR(30) NOT NULL,
  reason TEXT,
  committee_review_id BIGINT,
  audit_event_id UUID,
  timeline_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_waitlist_status_check
    CHECK (status IN ('listed', 'hold', 'inactive', 'removed', 'transplanted')),
  CONSTRAINT fk_transplant_waitlist_candidate
    FOREIGN KEY (candidate_id) REFERENCES transplant_candidates(id) ON DELETE CASCADE,
  CONSTRAINT fk_transplant_waitlist_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_transplant_waitlist_candidate_time
  ON transplant_waitlist_status_history (tenant_id, candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transplant_waitlist_status
  ON transplant_waitlist_status_history (tenant_id, status, created_at DESC);

ALTER TABLE transplant_waitlist_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_waitlist_status_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_waitlist_status_history;
CREATE POLICY tenant_isolation ON transplant_waitlist_status_history
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
