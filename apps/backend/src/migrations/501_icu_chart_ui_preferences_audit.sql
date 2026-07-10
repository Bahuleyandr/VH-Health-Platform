-- NL-14 P1: ICU chart UI preferences and append-only audit trail.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_chart_ui_preferences (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  user_uid UUID NOT NULL,
  unit_code VARCHAR(20),
  preference_key VARCHAR(80) NOT NULL DEFAULT 'default',
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_icu_chart_ui_preferences_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_icu_chart_ui_preferences_user
    FOREIGN KEY (user_uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_icu_chart_ui_preferences_user_key
  ON icu_chart_ui_preferences (tenant_id, user_uid, (COALESCE(unit_code, '')), preference_key);

CREATE TABLE IF NOT EXISTS icu_chart_audit_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID,
  icu_admission_id INTEGER REFERENCES icu_admissions(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  actor_uid UUID,
  resource_table VARCHAR(80),
  resource_id TEXT,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_icu_chart_audit_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_icu_chart_audit_events_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_icu_chart_audit_events_admission
  ON icu_chart_audit_events (tenant_id, icu_admission_id, occurred_at DESC)
  WHERE icu_admission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_icu_chart_audit_events_patient
  ON icu_chart_audit_events (tenant_id, patient_uid, occurred_at DESC)
  WHERE patient_uid IS NOT NULL;

ALTER TABLE icu_chart_ui_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_chart_ui_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_chart_ui_preferences;
CREATE POLICY tenant_isolation ON icu_chart_ui_preferences
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

ALTER TABLE icu_chart_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_chart_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_chart_audit_events;
CREATE POLICY tenant_isolation ON icu_chart_audit_events
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
