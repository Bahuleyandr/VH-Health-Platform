-- 381_order_set_content_studio_governance.sql
--
-- NL-5 P3: governed order-set/pathway lifecycle.
--
-- Existing clinical_order_sets rows are grandfathered as approved so the
-- composer picker keeps today's behavior until the tenant studio flag is
-- enabled and authors intentionally create draft versions.

BEGIN;

ALTER TABLE clinical_order_sets
  ADD COLUMN IF NOT EXISTS family_key VARCHAR(80),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by INTEGER,
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'authored',
  ADD COLUMN IF NOT EXISTS import_batch_id BIGINT;

UPDATE clinical_order_sets
   SET family_key = code
 WHERE family_key IS NULL;

ALTER TABLE clinical_order_sets
  ALTER COLUMN family_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_clinical_order_sets_status'
  ) THEN
    ALTER TABLE clinical_order_sets
      ADD CONSTRAINT chk_clinical_order_sets_status
      CHECK (status IN ('draft','in_review','approved','retired'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_clinical_order_sets_source'
  ) THEN
    ALTER TABLE clinical_order_sets
      ADD CONSTRAINT chk_clinical_order_sets_source
      CHECK (source IN ('authored','imported'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_clinical_order_sets_superseded_by'
  ) THEN
    ALTER TABLE clinical_order_sets
      ADD CONSTRAINT fk_clinical_order_sets_superseded_by
      FOREIGN KEY (superseded_by) REFERENCES clinical_order_sets(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clinical_order_sets_family_status
  ON clinical_order_sets(tenant_id, family_key, status, active, version DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_clinical_order_sets_deployed_family
  ON clinical_order_sets(tenant_id, family_key)
  WHERE status = 'approved' AND active = TRUE;

CREATE TABLE IF NOT EXISTS order_set_import_batches (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  import_key     VARCHAR(120) NOT NULL,
  format         VARCHAR(40) NOT NULL DEFAULT 'vh-order-set/1',
  source_file    TEXT,
  dry_run        BOOLEAN NOT NULL DEFAULT FALSE,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  row_count      INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  warning_count  INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_uid      UUID,
  started_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at   TIMESTAMPTZ(6),
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_order_set_import_batches_status
    CHECK (status IN ('pending','running','completed','failed','partial'))
);

CREATE INDEX IF NOT EXISTS idx_order_set_import_batches_tenant_created
  ON order_set_import_batches(tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_set_import_batches_tenant_key
  ON order_set_import_batches(tenant_id, import_key);

ALTER TABLE order_set_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_set_import_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_set_import_batches;
CREATE POLICY tenant_isolation ON order_set_import_batches
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_clinical_order_sets_import_batch'
  ) THEN
    ALTER TABLE clinical_order_sets
      ADD CONSTRAINT fk_clinical_order_sets_import_batch
      FOREIGN KEY (import_batch_id) REFERENCES order_set_import_batches(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_set_review_events (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_set_id  INTEGER NOT NULL REFERENCES clinical_order_sets(id) ON DELETE CASCADE,
  action        VARCHAR(20) NOT NULL,
  actor_uid     UUID,
  actor_role    VARCHAR(80),
  note          TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_order_set_review_events_action
    CHECK (action IN ('submit','approve','reject','retire','deploy','rollback'))
);

CREATE INDEX IF NOT EXISTS idx_order_set_review_events_set_created
  ON order_set_review_events(order_set_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_set_review_events_tenant_created
  ON order_set_review_events(tenant_id, created_at DESC);

ALTER TABLE order_set_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_set_review_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_set_review_events;
CREATE POLICY tenant_isolation ON order_set_review_events
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'ORDER_SET_CONTENT_STUDIO_GOVERNANCE_APPLIED',
  'clinical_order_sets',
  'clinical_order_sets',
  jsonb_build_object(
    'migration', '381_order_set_content_studio_governance.sql',
    'program', 'NL-5 P3',
    'migration_block', ARRAY[381,382],
    'reason', 'Add order-set lifecycle columns, review events, import batches, and deployed-family uniqueness.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ORDER_SET_CONTENT_STUDIO_GOVERNANCE_APPLIED'
    AND resource = 'clinical_order_sets'
);

COMMIT;
