-- 435_engagement_settings_templates.sql
-- NL9-P1 engagement foundation: per-tenant settings stay disabled by default,
-- and approved engagement templates reference the existing notification copy.

CREATE TABLE IF NOT EXISTS engagement_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ(6),
  enabled_by UUID,
  acceptance_snapshot JSONB,
  emergency_stop BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_hours_start TIME NOT NULL DEFAULT TIME '21:00',
  quiet_hours_end TIME NOT NULL DEFAULT TIME '08:00',
  tenant_daily_cap INTEGER NOT NULL DEFAULT 250,
  per_patient_cooldown_hours INTEGER NOT NULL DEFAULT 48,
  consent_max_age_days INTEGER NOT NULL DEFAULT 365,
  channel_caps JSONB NOT NULL DEFAULT '{"sms":100,"whatsapp":100,"push":250,"email":100,"inapp":250}'::jsonb,
  default_consent_map JSONB NOT NULL DEFAULT '{
    "appointment_recall":"care_reminder_whatsapp",
    "no_show_recall":"care_reminder_whatsapp",
    "feedback_nps_request":"nps_survey",
    "generic_follow_up_reminder":"teleconsult_followup",
    "rpm_enrollment_reminder":"rpm_monitoring"
  }'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT engagement_settings_daily_cap_check CHECK (tenant_daily_cap >= 0),
  CONSTRAINT engagement_settings_cooldown_check CHECK (per_patient_cooldown_hours >= 0),
  CONSTRAINT engagement_settings_consent_age_check CHECK (consent_max_age_days > 0)
);

CREATE TABLE IF NOT EXISTS engagement_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  notification_template_id INTEGER NOT NULL REFERENCES notification_templates(id),
  template_kind VARCHAR(60) NOT NULL,
  channel VARCHAR(20) NOT NULL,
  variables_schema JSONB NOT NULL DEFAULT '{"allowed":[]}'::jsonb,
  allowed_variables TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  phi_classification VARCHAR(30) NOT NULL DEFAULT 'minimal',
  locale VARCHAR(20) NOT NULL DEFAULT 'en-IN',
  approved_by UUID,
  approved_at TIMESTAMPTZ(6),
  retired_at TIMESTAMPTZ(6),
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_engagement_templates_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT engagement_templates_kind_check
    CHECK (template_kind IN (
      'appointment_recall',
      'no_show_recall',
      'feedback_nps_request',
      'generic_follow_up_reminder',
      'rpm_enrollment_reminder'
    )),
  CONSTRAINT engagement_templates_channel_check
    CHECK (channel IN ('push', 'sms', 'whatsapp', 'email', 'inapp')),
  CONSTRAINT engagement_templates_phi_check
    CHECK (phi_classification IN ('minimal', 'operational', 'phi_prohibited'))
);

CREATE INDEX IF NOT EXISTS idx_engagement_templates_tenant_kind
  ON engagement_templates (tenant_id, template_kind, channel)
  WHERE retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_engagement_templates_active_copy
  ON engagement_templates (tenant_id, notification_template_id, channel, locale)
  WHERE retired_at IS NULL;

ALTER TABLE engagement_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON engagement_settings;
CREATE POLICY tenant_isolation ON engagement_settings
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

ALTER TABLE engagement_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON engagement_templates;
CREATE POLICY tenant_isolation ON engagement_templates
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
