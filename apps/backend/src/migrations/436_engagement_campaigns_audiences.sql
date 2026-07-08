-- 436_engagement_campaigns_audiences.sql
-- NL9-P1 campaign headers and immutable audience snapshots.

CREATE TABLE IF NOT EXISTS engagement_campaigns (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  campaign_type VARCHAR(60) NOT NULL,
  objective TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  template_id BIGINT NOT NULL REFERENCES engagement_templates(id),
  channels TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  schedule_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  rate_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  audience_kind VARCHAR(20) NOT NULL DEFAULT 'cohort',
  approval_required_role VARCHAR(30) NOT NULL DEFAULT 'care_team',
  created_by UUID,
  submitted_by UUID,
  submitted_at TIMESTAMPTZ(6),
  approved_by UUID,
  approved_at TIMESTAMPTZ(6),
  scheduled_at TIMESTAMPTZ(6),
  started_at TIMESTAMPTZ(6),
  completed_at TIMESTAMPTZ(6),
  cancelled_at TIMESTAMPTZ(6),
  frozen_audience_hash VARCHAR(128),
  current_audience_snapshot_id BIGINT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_engagement_campaigns_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT engagement_campaigns_type_check
    CHECK (campaign_type IN (
      'appointment_recall',
      'no_show_recall',
      'feedback_nps_request',
      'generic_follow_up_reminder',
      'rpm_enrollment_reminder'
    )),
  CONSTRAINT engagement_campaigns_status_check
    CHECK (status IN (
      'draft',
      'dry_run',
      'pending_approval',
      'scheduled',
      'running',
      'paused',
      'completed',
      'archived',
      'cancelled'
    )),
  CONSTRAINT engagement_campaigns_channels_check
    CHECK (channels <@ ARRAY['push','sms','whatsapp','email','inapp']::TEXT[]),
  CONSTRAINT engagement_campaigns_audience_kind_check
    CHECK (audience_kind IN ('broad', 'cohort')),
  CONSTRAINT engagement_campaigns_approval_role_check
    CHECK (approval_required_role IN ('admin_quality', 'care_team'))
);

CREATE TABLE IF NOT EXISTS engagement_audience_snapshots (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  campaign_id BIGINT NOT NULL REFERENCES engagement_campaigns(id) ON DELETE CASCADE,
  snapshot_kind VARCHAR(20) NOT NULL DEFAULT 'dry_run',
  cohort_source JSONB NOT NULL DEFAULT '{}'::jsonb,
  cohort_hash VARCHAR(128) NOT NULL,
  materialized_count INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  source_tables TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  minimum_cohort_size INTEGER NOT NULL DEFAULT 1,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_engagement_audience_snapshots_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT engagement_audience_snapshots_kind_check
    CHECK (snapshot_kind IN ('dry_run', 'materialized')),
  CONSTRAINT engagement_audience_snapshots_counts_check
    CHECK (
      materialized_count >= 0
      AND eligible_count >= 0
      AND suppressed_count >= 0
      AND minimum_cohort_size >= 1
    )
);

CREATE INDEX IF NOT EXISTS idx_engagement_campaigns_tenant_status
  ON engagement_campaigns (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engagement_audience_snapshots_campaign
  ON engagement_audience_snapshots (tenant_id, campaign_id, created_at DESC);

ALTER TABLE engagement_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_campaigns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON engagement_campaigns;
CREATE POLICY tenant_isolation ON engagement_campaigns
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

ALTER TABLE engagement_audience_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_audience_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON engagement_audience_snapshots;
CREATE POLICY tenant_isolation ON engagement_audience_snapshots
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
