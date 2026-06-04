-- Staff/HR access decision audit trail.
-- Patient PHI access remains in patient_access_audit_log; this table is only
-- for staff governance, HR-processing, attendance, leave, and payroll access.

CREATE TABLE IF NOT EXISTS staff_access_audit_log (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_staff_uid      UUID,
  target_user_id        INTEGER,
  target_staff_id       INTEGER,
  target_role           VARCHAR(80),
  actor_uid             UUID,
  actor_role            VARCHAR(80),
  access_decision       VARCHAR(20) NOT NULL
    CHECK (access_decision IN ('allow', 'deny')),
  access_source         VARCHAR(40) NOT NULL
    CHECK (access_source IN (
      'self', 'hr_process', 'reporting_scope', 'management_scope', 'role', 'system', 'unknown'
    )),
  policy_code           VARCHAR(120) NOT NULL,
  resource_type         VARCHAR(80),
  resource_id           VARCHAR(120),
  route                 VARCHAR(255),
  action                VARCHAR(120),
  reason                TEXT,
  request_id            VARCHAR(120),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_access_audit_target_time
  ON staff_access_audit_log (tenant_id, target_staff_uid, created_at DESC)
  WHERE target_staff_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_access_audit_actor_time
  ON staff_access_audit_log (tenant_id, actor_uid, created_at DESC)
  WHERE actor_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_access_audit_decision_time
  ON staff_access_audit_log (tenant_id, access_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_access_audit_policy_time
  ON staff_access_audit_log (tenant_id, policy_code, created_at DESC);
