-- 283_hl7_outbound_feeds.sql
--
-- Roadmap Pillar C / item C2 (docs/EPIC_LEVEL_ROADMAP.md) — live outbound
-- HL7v2 feeds. The transformer has generated ADT/ORM/ORU messages since
-- Sprint 3, but nothing ever EMITTED them: third-party systems (existing
-- LIS, insurance gateways, state HIE bridges) had no way to subscribe.
--
--   * hl7_feed_subscriptions — who receives which message types over an
--     HTTP bridge endpoint (MLLP transports terminate into the same bridge
--     owner-side, mirroring the B3 inbound pattern).
--   * hl7_outbound_messages  — durable per-subscription queue with
--     exponential-backoff retries and replay; PHI payloads → tenant RLS.
--
-- Emission hooks: admission created (ADT^A01), patient discharged
-- (ADT^A03), lab results signed off (ORU^R01) — all Phase-1.5 best-effort
-- after the clinical write commits.

BEGIN;

CREATE TABLE IF NOT EXISTS hl7_feed_subscriptions (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  name          VARCHAR(120) NOT NULL,
  endpoint_url  TEXT NOT NULL,
  auth_header   TEXT,
  message_types TEXT[] NOT NULL DEFAULT ARRAY['ADT^A01', 'ADT^A03', 'ORU^R01'],
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_delivery_at TIMESTAMPTZ(6),
  created_by    UUID,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hl7_feed_subscriptions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_hl7_feed_subscriptions_name UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS hl7_outbound_messages (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  subscription_id    INTEGER NOT NULL REFERENCES hl7_feed_subscriptions(id) ON DELETE CASCADE,
  message_type       VARCHAR(20) NOT NULL,
  message_control_id VARCHAR(60),
  hl7_payload        TEXT NOT NULL,
  source_table       VARCHAR(60),
  source_id          VARCHAR(60),
  patient_uid        UUID,
  status             VARCHAR(12) NOT NULL DEFAULT 'queued',
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  next_attempt_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at            TIMESTAMPTZ(6),
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hl7_outbound_messages_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_hl7_outbound_messages_status
    CHECK (status IN ('queued', 'sent', 'failed', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_hl7_outbound_messages_due
  ON hl7_outbound_messages (status, next_attempt_at)
  WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_hl7_outbound_messages_subscription
  ON hl7_outbound_messages (subscription_id, created_at DESC);

-- Tenant isolation (262/272 pattern) — outbound payloads carry PHI.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['hl7_feed_subscriptions', 'hl7_outbound_messages'];
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
  'HL7_OUTBOUND_FEEDS_APPLIED',
  'hl7_feed_subscriptions',
  'hl7_feed_subscriptions',
  jsonb_build_object(
    'migration', '283_hl7_outbound_feeds.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#C2',
    'reason', 'Outbound HL7v2 feed subscriptions + durable retry queue; ADT^A01/A03 + ORU^R01 emitted at admission/discharge/result-signoff.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'HL7_OUTBOUND_FEEDS_APPLIED'
    AND resource = 'hl7_feed_subscriptions'
);

COMMIT;
