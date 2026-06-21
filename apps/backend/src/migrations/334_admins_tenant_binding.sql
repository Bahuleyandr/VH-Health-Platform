-- 334_admins_tenant_binding.sql
--
-- W2 (multi-tenancy program) — schema completeness, HIGH. Decision §8.2:
-- admin identity becomes tenant-bound. A tenant ADMIN belongs to exactly one
-- tenant; a platform SUPER_ADMIN is tenant-null (the only cross-tenant actor).
--
-- Unlike the other Pattern-A tables, tenant_id here is NULLABLE by design:
--   * tenant_id IS NULL    -> platform SUPER_ADMIN
--   * tenant_id IS NOT NULL -> tenant ADMIN (FK-checked against tenants)
-- and there is NO column DEFAULT — a GUC-reading default would wrongly stamp
-- the literal default tenant onto a SUPER_ADMIN created outside any tenant
-- context. The app sets tenant_id explicitly at admin creation. admins is
-- empty in current data, so there is nothing to backfill.
--
-- USERNAME UNIQUENESS — split into two partial uniques (verified the only
-- pre-existing unique is the global admins_username_key, a standalone INDEX
-- with no FK depending on it):
--   * uniq_admins_tenant_username   (tenant_id, username) WHERE tenant_id IS NOT NULL
--       — two hospitals may both have an "admin" username.
--   * uniq_admins_platform_username (username)            WHERE tenant_id IS NULL
--       — SUPER_ADMIN usernames stay globally unique among platform admins.
--   (A tenant ADMIN and a SUPER_ADMIN may share a username; admin login
--    resolves the namespace from the per-tenant subdomain vs the super-admin
--    console — wired in W5.)
--
-- RLS — §8.2 leaves admins RLS optional ("policy vs app-enforcement"). admins
-- is tenant-owned (ADMINs are tenant-bound), so per the check-phi-tenant-id
-- philosophy it gets a tenant_isolation policy rather than a POLICY_ALLOWLIST
-- exemption (which is kept empty). The policy is ASYMMETRIC to model the
-- nullable SUPER_ADMIN correctly:
--   * USING adds `OR tenant_id IS NULL` — platform SUPER_ADMIN rows are
--     readable in every tenant context (and pre-auth admin login, which runs
--     with no GUC, hits the permissive-when-unset branch and sees everyone).
--   * WITH CHECK omits the IS NULL branch — a tenant-scoped context may only
--     write its OWN tenant's admin rows; it cannot mint a platform SUPER_ADMIN
--     (those are created only in the unset/bypass platform context).
-- NO-OP for single-tenant admin login until W5 (permissive when the GUC is
-- unset). Mirrors migration 239/304 for the canonical clauses.

BEGIN;

-- ---------------------------------------------------------------------------
-- Nullable tenant_id + FK + index. No NOT NULL, no DEFAULT (SUPER_ADMIN=null).
-- ---------------------------------------------------------------------------
ALTER TABLE admins ADD COLUMN IF NOT EXISTS tenant_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_admins_tenant') THEN
    ALTER TABLE admins
      ADD CONSTRAINT fk_admins_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_admins_tenant_id ON admins (tenant_id);

-- ---------------------------------------------------------------------------
-- Per-tenant username uniqueness (dual partial).
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS admins_username_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_admins_tenant_username
  ON admins (tenant_id, username) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_admins_platform_username
  ON admins (username) WHERE tenant_id IS NULL;

-- ---------------------------------------------------------------------------
-- Asymmetric tenant_isolation policy (SUPER_ADMIN-aware).
-- ---------------------------------------------------------------------------
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE admins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON admins;
CREATE POLICY tenant_isolation ON admins
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id IS NULL
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMIT;
