-- 274_staff_queries.sql
--
-- Drift repair (found during roadmap A3 schema work, 2026-06-10).
-- prisma/schema.prisma carries a `staff_queries` model, but NO migration
-- ever created the table — it exists only on environments where it was
-- created ad hoc (dev cluster). Any environment built strictly from
-- migrations (CI, QA, a fresh prod cluster) lacks it, and `prisma db pull`
-- from such an environment silently deletes the model again.
--
-- DDL below matches the schema.prisma model exactly. IF NOT EXISTS
-- everywhere so environments that already have the table are no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_queries (
  id              SERIAL PRIMARY KEY,
  uid             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  staff_uid       uuid NOT NULL,
  category        varchar(80) NOT NULL DEFAULT 'general',
  subject         varchar(200) NOT NULL,
  body            text NOT NULL,
  priority        varchar(20) NOT NULL DEFAULT 'normal',
  status          varchar(30) NOT NULL DEFAULT 'submitted',
  assigned_to_uid uuid,
  resolution      text,
  resolved_at     timestamptz(6),
  resolved_by     uuid,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_queries_uid_key
  ON staff_queries (uid);
CREATE INDEX IF NOT EXISTS idx_staff_queries_tenant_created
  ON staff_queries (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_queries_staff_created
  ON staff_queries (staff_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_queries_status_priority
  ON staff_queries (status, priority, created_at DESC);

COMMIT;
