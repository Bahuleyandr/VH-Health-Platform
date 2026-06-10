-- 294_portal_results_release_proxy.sql
--
-- Roadmap Pillar E / item E6 (docs/EPIC_LEVEL_ROADMAP.md) — patient portal
-- open results + formal proxy access.
--
--   * Result release rules on lab_results: portal visibility becomes
--     "signed off AND (auto-release delay elapsed OR released early by a
--     clinician) AND not on hold". Doctor hold (reason required) blocks
--     release until lifted or explicitly released. Existing signed-off
--     rows are backfilled as already-released so nothing a patient could
--     already see disappears.
--   * portal_proxy_grants: formal proxy access for dependents/relatives
--     with a consent trail (method + reference + grantor + expiry +
--     revocation). One ACTIVE grant per patient × proxy. Every proxy read
--     is audited by the service layer.

BEGIN;

ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS released_to_patient_at TIMESTAMPTZ(6);
ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS release_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS release_hold_by UUID;
ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS release_hold_reason TEXT;
ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS release_hold_at TIMESTAMPTZ(6);

-- Back-compat: rows patients could already see (signed off pre-migration)
-- stay visible — treat sign-off time as the release time.
UPDATE lab_results
   SET released_to_patient_at = signed_off_at
 WHERE signed_off_at IS NOT NULL
   AND released_to_patient_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lab_results_release
  ON lab_results (patient_uid, released_to_patient_at)
  WHERE release_hold = false;

CREATE TABLE IF NOT EXISTS portal_proxy_grants (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid    UUID NOT NULL,
  proxy_uid      UUID NOT NULL,
  relationship   VARCHAR(40),
  scope          TEXT[] NOT NULL DEFAULT ARRAY['results'],
  status         VARCHAR(12) NOT NULL DEFAULT 'active',
  consent_method VARCHAR(20) NOT NULL,
  consent_ref    VARCHAR(200),
  granted_by     UUID,
  granted_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     TIMESTAMPTZ(6),
  revoked_at     TIMESTAMPTZ(6),
  revoked_by     UUID,
  revoked_reason TEXT,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_portal_proxy_grants_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_portal_proxy_grants_status CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT chk_portal_proxy_grants_method
    CHECK (consent_method IN ('written', 'verbal_documented', 'otp', 'guardian_minor')),
  CONSTRAINT chk_portal_proxy_grants_distinct CHECK (patient_uid <> proxy_uid)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_proxy_grants_active
  ON portal_proxy_grants (patient_uid, proxy_uid)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_portal_proxy_grants_proxy
  ON portal_proxy_grants (proxy_uid, status);

-- Tenant isolation (262/272 pattern) — grants govern PHI access.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['portal_proxy_grants'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $f$, t);
  END LOOP;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'PORTAL_RESULTS_RELEASE_PROXY_APPLIED',
  'portal_proxy_grants',
  'portal_proxy_grants',
  jsonb_build_object(
    'migration', '294_portal_results_release_proxy.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#E6',
    'reason', 'Result release rules (auto-release delay, doctor hold, early release) + formal proxy access grants with consent trail.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'PORTAL_RESULTS_RELEASE_PROXY_APPLIED'
    AND resource = 'portal_proxy_grants'
);

COMMIT;
