-- 437_engagement_recipients_suppressions.sql
-- NL9-P1 per-patient campaign recipient ledger and suppression audit anchor.

CREATE TABLE IF NOT EXISTS engagement_campaign_recipients (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  campaign_id BIGINT NOT NULL REFERENCES engagement_campaigns(id) ON DELETE CASCADE,
  audience_snapshot_id BIGINT REFERENCES engagement_audience_snapshots(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL,
  consent_id INTEGER REFERENCES patient_consents(id) ON DELETE SET NULL,
  required_consent_type VARCHAR(100) NOT NULL,
  channel VARCHAR(20) NOT NULL,
  contact_route TEXT,
  due_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  status VARCHAR(30) NOT NULL DEFAULT 'eligible',
  suppression_reason VARCHAR(80),
  outbox_id INTEGER REFERENCES notification_outbox(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(180) NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  materialized_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  last_consent_checked_at TIMESTAMPTZ(6),
  queued_at TIMESTAMPTZ(6),
  sent_at TIMESTAMPTZ(6),
  failed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_engagement_campaign_recipients_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT engagement_campaign_recipients_channel_check
    CHECK (channel IN ('push', 'sms', 'whatsapp', 'email', 'inapp')),
  CONSTRAINT engagement_campaign_recipients_status_check
    CHECK (status IN ('eligible', 'suppressed', 'queued', 'sent', 'failed', 'cancelled')),
  CONSTRAINT engagement_campaign_recipients_retry_check CHECK (retry_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_engagement_recipient_idempotency
  ON engagement_campaign_recipients (tenant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_engagement_recipients_due
  ON engagement_campaign_recipients (tenant_id, status, due_at)
  WHERE status = 'eligible';

CREATE INDEX IF NOT EXISTS idx_engagement_recipients_patient
  ON engagement_campaign_recipients (tenant_id, patient_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS engagement_suppression_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  campaign_id BIGINT REFERENCES engagement_campaigns(id) ON DELETE SET NULL,
  patient_uid UUID,
  event_type VARCHAR(40) NOT NULL,
  channel VARCHAR(20),
  reason_code VARCHAR(80) NOT NULL,
  reason TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source VARCHAR(40) NOT NULL DEFAULT 'system',
  created_by UUID,
  expires_at TIMESTAMPTZ(6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_engagement_suppression_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT engagement_suppression_events_type_check
    CHECK (event_type IN (
      'opt_out',
      'complaint',
      'cooldown',
      'duplicate',
      'deceased',
      'tenant_emergency_stop',
      'manual_suppression',
      'consent_denied',
      'quiet_hours',
      'daily_cap'
    )),
  CONSTRAINT engagement_suppression_events_channel_check
    CHECK (channel IS NULL OR channel IN ('push', 'sms', 'whatsapp', 'email', 'inapp'))
);

CREATE INDEX IF NOT EXISTS idx_engagement_suppressions_active_patient
  ON engagement_suppression_events (tenant_id, patient_uid, active, expires_at)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_engagement_suppressions_campaign
  ON engagement_suppression_events (tenant_id, campaign_id, created_at DESC);

ALTER TABLE engagement_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_campaign_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON engagement_campaign_recipients;
CREATE POLICY tenant_isolation ON engagement_campaign_recipients
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

ALTER TABLE engagement_suppression_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_suppression_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON engagement_suppression_events;
CREATE POLICY tenant_isolation ON engagement_suppression_events
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
