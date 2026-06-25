-- 346_appointment_archive.sql
-- Backing table for DELETE /api/v1/appointments/admin/bulk-delete, which
-- archives each appointment row (plus deletion audit metadata) BEFORE deleting
-- it. The table was historically only created by the legacy
-- src/scripts/init-db.js bootstrap — and with fewer columns than the handler
-- INSERTs (no notes/deleted_by/deleted_at/deletion_reason) — so it was absent
-- from the migration-driven schema and the endpoint 500'd on a missing relation.
-- The column set below mirrors the handler's INSERT...SELECT exactly.
CREATE TABLE IF NOT EXISTS appointment_archive (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  original_id      INTEGER,
  patient_id       INTEGER,
  doctor_id        INTEGER,
  appointment_date DATE,
  status           VARCHAR(50),
  reason           TEXT,
  notes            TEXT,
  deleted_by       UUID,
  deleted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deletion_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_appointment_archive_original_id
  ON appointment_archive (original_id);
CREATE INDEX IF NOT EXISTS idx_appointment_archive_tenant_id
  ON appointment_archive (tenant_id);

-- RLS (mig-075 tenant_isolation pattern). Permissive when the GUC is unset, so
-- the admin bulk-delete handler's plain-prisma INSERT (no tenant GUC) keeps
-- working, while cross-tenant reads/writes are blocked once the GUC is set.
ALTER TABLE appointment_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_archive FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON appointment_archive;
CREATE POLICY tenant_isolation ON appointment_archive
  USING (
    tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      tenant_id)
  );
