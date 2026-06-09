CREATE TABLE IF NOT EXISTS staff_queries (
  id SERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  staff_uid UUID NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'general',
  subject VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(30) NOT NULL DEFAULT 'submitted',
  assigned_to_uid UUID NULL,
  resolution TEXT NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolved_by UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_queries_uid_key ON staff_queries(uid);
CREATE INDEX IF NOT EXISTS idx_staff_queries_tenant_created ON staff_queries(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_queries_staff_created ON staff_queries(staff_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_queries_status_priority ON staff_queries(status, priority, created_at DESC);
