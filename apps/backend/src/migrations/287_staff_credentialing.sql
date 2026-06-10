-- 287_staff_credentialing.sql
--
-- Roadmap Pillar D / item D3 (docs/EPIC_LEVEL_ROADMAP.md) — provider
-- credentialing & privileging. Registration numbers/qualifications were
-- free text scattered across doctors/staff profiles; nothing tracked
-- expiry or modelled privileges ("who may operate / administer chemo /
-- prescribe schedule X"). NABH asks for exactly this registry.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_credentials (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  staff_uid           UUID NOT NULL,
  credential_type     VARCHAR(20) NOT NULL,
  name                VARCHAR(200) NOT NULL,
  issuing_body        VARCHAR(200),
  registration_number VARCHAR(120),
  valid_from          DATE,
  valid_until         DATE,
  status              VARCHAR(20) NOT NULL DEFAULT 'active',
  document_ref        VARCHAR(255),
  verified_by         UUID,
  verified_at         TIMESTAMPTZ(6),
  notes               VARCHAR(400),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          UUID,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_staff_credentials_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_staff_credentials_type
    CHECK (credential_type IN ('registration', 'qualification', 'privilege', 'training', 'immunization')),
  CONSTRAINT chk_staff_credentials_status
    CHECK (status IN ('active', 'suspended', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_staff_credentials_staff
  ON staff_credentials (staff_uid, credential_type, status);
CREATE INDEX IF NOT EXISTS idx_staff_credentials_expiry
  ON staff_credentials (valid_until) WHERE valid_until IS NOT NULL AND status = 'active';

-- One active privilege of a given name per staff member.
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_credentials_active_privilege
  ON staff_credentials (tenant_id, staff_uid, name)
  WHERE credential_type = 'privilege' AND status = 'active';

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT 'STAFF_CREDENTIALING_APPLIED', 'staff_credentials', 'staff_credentials',
  jsonb_build_object('migration', '287_staff_credentialing.sql', 'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D3',
    'reason', 'Credential/privilege registry with expiry tracking; privilege checks exposed for clinical gating (first consumer: D1 chemo administration).'),
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs')
  AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'STAFF_CREDENTIALING_APPLIED');

COMMIT;
