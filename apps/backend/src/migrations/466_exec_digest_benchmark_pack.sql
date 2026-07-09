-- 466_exec_digest_benchmark_pack.sql
-- NL10-B3: executive mobile digest plus internal-only benchmark pack.
-- Deploy is HELD: settings/subscriptions are disabled by default, digest
-- delivery is locked to in-app plus push, and benchmark packs cannot be marked
-- externally shareable by this slice.

BEGIN;

CREATE TABLE IF NOT EXISTS analytics_exec_digest_settings (
  tenant_id                 UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at                TIMESTAMPTZ(6),
  enabled_by                UUID REFERENCES users(uid) ON DELETE SET NULL,
  acceptance_snapshot       JSONB,
  delivery_channel_policy   VARCHAR(40) NOT NULL DEFAULT 'in_app_push_locked',
  metric_bundle             VARCHAR(60) NOT NULL DEFAULT 'executive_core',
  minimum_cell_threshold    INTEGER NOT NULL DEFAULT 5,
  created_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT analytics_exec_digest_channel_policy_ck
    CHECK (delivery_channel_policy = 'in_app_push_locked'),
  CONSTRAINT analytics_exec_digest_threshold_ck
    CHECK (minimum_cell_threshold >= 5)
);

CREATE TABLE IF NOT EXISTS analytics_exec_digest_subscriptions (
  id                        BIGSERIAL PRIMARY KEY,
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_user_uid           UUID REFERENCES users(uid) ON DELETE CASCADE,
  target_role               VARCHAR(80),
  cadence                   VARCHAR(20) NOT NULL DEFAULT 'daily',
  local_delivery_hour       SMALLINT NOT NULL DEFAULT 8,
  metric_bundle             VARCHAR(60) NOT NULL DEFAULT 'executive_core',
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  last_delivered_at         TIMESTAMPTZ(6),
  delivery_channel_policy   VARCHAR(40) NOT NULL DEFAULT 'in_app_push_locked',
  created_by                UUID REFERENCES users(uid) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT analytics_exec_digest_subscription_target_ck
    CHECK (target_user_uid IS NOT NULL OR NULLIF(target_role, '') IS NOT NULL),
  CONSTRAINT analytics_exec_digest_subscription_cadence_ck
    CHECK (cadence IN ('daily', 'weekly')),
  CONSTRAINT analytics_exec_digest_subscription_hour_ck
    CHECK (local_delivery_hour BETWEEN 0 AND 23),
  CONSTRAINT analytics_exec_digest_subscription_policy_ck
    CHECK (delivery_channel_policy = 'in_app_push_locked')
);

CREATE INDEX IF NOT EXISTS idx_analytics_exec_digest_subs_tenant
  ON analytics_exec_digest_subscriptions (tenant_id, enabled, cadence);

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_exec_digest_sub_user
  ON analytics_exec_digest_subscriptions (tenant_id, target_user_uid, cadence, metric_bundle)
  WHERE target_user_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_exec_digest_sub_role
  ON analytics_exec_digest_subscriptions (tenant_id, target_role, cadence, metric_bundle)
  WHERE target_role IS NOT NULL;

CREATE TABLE IF NOT EXISTS analytics_exec_digest_deliveries (
  id                        BIGSERIAL PRIMARY KEY,
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id           BIGINT REFERENCES analytics_exec_digest_subscriptions(id) ON DELETE SET NULL,
  target_user_uid           UUID REFERENCES users(uid) ON DELETE SET NULL,
  target_role               VARCHAR(80),
  digest_date               DATE NOT NULL,
  period_start              DATE NOT NULL,
  period_end                DATE NOT NULL,
  metric_bundle             VARCHAR(60) NOT NULL DEFAULT 'executive_core',
  delivery_channels         TEXT[] NOT NULL DEFAULT ARRAY['inapp','push']::TEXT[],
  delivery_channel_policy   VARCHAR(40) NOT NULL DEFAULT 'in_app_push_locked',
  warehouse_snapshot        JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  in_app_notification_id    INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  notification_outbox_id    INTEGER REFERENCES notification_outbox(id) ON DELETE SET NULL,
  status                    VARCHAR(30) NOT NULL DEFAULT 'queued',
  failure_reason            TEXT,
  generated_at              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  sent_at                   TIMESTAMPTZ(6),
  created_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT analytics_exec_digest_delivery_period_ck
    CHECK (period_end >= period_start),
  CONSTRAINT analytics_exec_digest_delivery_channels_ck
    CHECK (
      array_length(delivery_channels, 1) = 2
      AND delivery_channels @> ARRAY['inapp','push']::TEXT[]
      AND delivery_channels <@ ARRAY['inapp','push']::TEXT[]
    ),
  CONSTRAINT analytics_exec_digest_delivery_policy_ck
    CHECK (delivery_channel_policy = 'in_app_push_locked'),
  CONSTRAINT analytics_exec_digest_delivery_status_ck
    CHECK (status IN ('queued', 'sent', 'skipped', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_exec_digest_deliveries_tenant_date
  ON analytics_exec_digest_deliveries (tenant_id, digest_date DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_exec_digest_deliveries_subscription
  ON analytics_exec_digest_deliveries (subscription_id, digest_date DESC);

CREATE TABLE IF NOT EXISTS analytics_benchmark_pack_exports (
  id                        BIGSERIAL PRIMARY KEY,
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pack_key                  VARCHAR(80) NOT NULL DEFAULT 'executive_internal_v1',
  period_start              DATE NOT NULL,
  period_end                DATE NOT NULL,
  visibility                VARCHAR(30) NOT NULL DEFAULT 'internal',
  external_sharing_allowed  BOOLEAN NOT NULL DEFAULT FALSE,
  minimum_cell_threshold    INTEGER NOT NULL DEFAULT 5,
  suppression_policy        VARCHAR(40) NOT NULL DEFAULT 'min_cell_locked',
  included_datasets         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metrics_payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  suppression_metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  suppressed_cells_count    INTEGER NOT NULL DEFAULT 0,
  approval_status           VARCHAR(30) NOT NULL DEFAULT 'not_requested',
  approved_by               UUID REFERENCES users(uid) ON DELETE SET NULL,
  approved_at               TIMESTAMPTZ(6),
  generated_by              UUID REFERENCES users(uid) ON DELETE SET NULL,
  generated_at              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  artifact_ref              TEXT,
  created_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT analytics_benchmark_pack_period_ck
    CHECK (period_end >= period_start),
  CONSTRAINT analytics_benchmark_pack_visibility_ck
    CHECK (visibility = 'internal'),
  CONSTRAINT analytics_benchmark_pack_external_ck
    CHECK (external_sharing_allowed = FALSE),
  CONSTRAINT analytics_benchmark_pack_threshold_ck
    CHECK (minimum_cell_threshold >= 5),
  CONSTRAINT analytics_benchmark_pack_suppression_ck
    CHECK (suppression_policy = 'min_cell_locked'),
  CONSTRAINT analytics_benchmark_pack_suppressed_count_ck
    CHECK (suppressed_cells_count >= 0),
  CONSTRAINT analytics_benchmark_pack_approval_ck
    CHECK (approval_status IN ('not_requested', 'internal_approved'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_benchmark_pack_exports_tenant_period
  ON analytics_benchmark_pack_exports (tenant_id, period_start DESC, period_end DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_benchmark_pack_exports_slice
  ON analytics_benchmark_pack_exports (tenant_id, pack_key, period_start, period_end);

ALTER TABLE analytics_exec_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_exec_digest_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics_exec_digest_settings;
CREATE POLICY tenant_isolation ON analytics_exec_digest_settings
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

ALTER TABLE analytics_exec_digest_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_exec_digest_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics_exec_digest_subscriptions;
CREATE POLICY tenant_isolation ON analytics_exec_digest_subscriptions
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

ALTER TABLE analytics_exec_digest_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_exec_digest_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics_exec_digest_deliveries;
CREATE POLICY tenant_isolation ON analytics_exec_digest_deliveries
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

ALTER TABLE analytics_benchmark_pack_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_benchmark_pack_exports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics_benchmark_pack_exports;
CREATE POLICY tenant_isolation ON analytics_benchmark_pack_exports
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
