-- Keep legacy and bootstrap user creation compatible with the tenant foundation.
-- The tenant middleware already falls back to this deterministic default tenant
-- when no tenant claim/header is present, so the database should do the same
-- for older insert paths that predate multi-tenancy.
ALTER TABLE users
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001';
