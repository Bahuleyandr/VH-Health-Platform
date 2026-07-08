-- NL-8 P1: short-lived signed kiosk sessions.
-- This is browser/tablet identity over the existing HTTPS boundary, not an
-- NL-7 device transport or LAN listener.

CREATE TABLE IF NOT EXISTS patient_flow_kiosk_sessions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_jti     UUID NOT NULL DEFAULT gen_random_uuid(),
  token_hash      CHAR(64) NOT NULL,
  department_key  VARCHAR(120) NOT NULL,
  channel         VARCHAR(30) NOT NULL DEFAULT 'kiosk_self',
  device_label    VARCHAR(160),
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at      TIMESTAMPTZ(6) NOT NULL,
  created_by      UUID,
  revoked_by      UUID,
  revoked_at      TIMESTAMPTZ(6),
  last_seen_at    TIMESTAMPTZ(6),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT patient_flow_kiosk_sessions_jti_unique UNIQUE (tenant_id, session_jti),
  CONSTRAINT patient_flow_kiosk_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT patient_flow_kiosk_sessions_channel_check
    CHECK (channel IN ('kiosk_self', 'kiosk_supervised')),
  CONSTRAINT patient_flow_kiosk_sessions_status_check
    CHECK (status IN ('active', 'expired', 'revoked')),
  CONSTRAINT patient_flow_kiosk_sessions_department_key_check
    CHECK (department_key = lower(department_key) AND department_key ~ '^[a-z0-9][a-z0-9_-]{0,119}$')
);

CREATE INDEX IF NOT EXISTS idx_patient_flow_kiosk_sessions_active
  ON patient_flow_kiosk_sessions (tenant_id, department_key, expires_at)
  WHERE status = 'active';

ALTER TABLE patient_flow_kiosk_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_flow_kiosk_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON patient_flow_kiosk_sessions;
CREATE POLICY tenant_isolation ON patient_flow_kiosk_sessions
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
