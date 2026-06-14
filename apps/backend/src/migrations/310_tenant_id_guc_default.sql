-- 310_tenant_id_guc_default.sql
--
-- WS1 B1.2 — multi-tenant INSERT completion.
--
-- PROBLEM. Every policied PHI `tenant_id` column DEFAULTs to the LITERAL
-- default tenant ('00000000-0000-4000-8000-000000000001'::uuid) — see the 62
-- such defaults baked into 000_baseline.sql and the per-domain migrations. The
-- `tenant_isolation` policy installed by 075 / 236 / 238 / 239 / 304 has a
-- WITH CHECK that requires `row.tenant_id = app_current_tenant_id_uuid()`
-- whenever the GUC `app.current_tenant_id` is a real uuid. So an INSERT issued
-- under setTenant(X) where X != the default tenant, that does NOT name
-- tenant_id explicitly, gets the LITERAL default for tenant_id, which then
-- fails the WITH CHECK (default != X) and is rejected with 42501
-- (insufficient_privilege / new row violates row-level security policy).
-- Net effect today: only single-tenant inserts (X = default) succeed via the
-- column default; every other tenant must spell tenant_id out at every INSERT
-- site or the write 42501s. Inserts that already set tenant_id explicitly are
-- unaffected (they satisfy WITH CHECK directly) and MUST stay unaffected.
--
-- FIX. Change the DEFAULT on every policied tenant_id column so it READS THE
-- GUC: use the request tenant when one is set, else fall back to the literal
-- default tenant. The default expression is the exact dual of the helper
-- app_current_tenant_id_uuid() the policy already uses:
--
--   COALESCE(
--     NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
--     '00000000-0000-4000-8000-000000000001'::uuid
--   )
--
-- Semantics (verified against the policy's three GUC cases):
--   * GUC = valid uuid  -> current_setting returns that text; the two NULLIFs
--     pass it through (it is neither '' nor 'bypass'); ::uuid yields the uuid;
--     COALESCE returns it. The inserted tenant_id == the GUC, so WITH CHECK
--     (tenant_id = app_current_tenant_id_uuid()) holds -> INSERT succeeds and
--     auto-scopes to the request tenant. THIS is the bug fix.
--   * GUC unset         -> current_setting('...', true) returns NULL (the
--     `true` = missing_ok suppresses the error); outer NULLIF(NULL,'bypass')
--     stays NULL; ::uuid of NULL is NULL; COALESCE falls back to the default
--     tenant. Matches the policy's permissive branch -> single-tenant inserts
--     keep working exactly as before.
--   * GUC = ''          -> inner NULLIF(...,'') -> NULL -> COALESCE -> default
--     tenant. (Permissive branch.)
--   * GUC = 'bypass'    -> inner NULLIF passes '' through? no: value is
--     'bypass', inner NULLIF('bypass','') = 'bypass', outer
--     NULLIF('bypass','bypass') = NULL -> COALESCE -> default tenant. So a
--     SUPER_ADMIN bypass insert with no explicit tenant_id lands in the
--     default tenant (the policy's bypass branch allows ANY tenant_id on
--     write, so this is safe and predictable).
--
-- Why a column DEFAULT and not a trigger: DEFAULT expressions are evaluated
-- per-row at INSERT time in the inserting session's GUC context, BEFORE any
-- BEFORE-INSERT trigger fires — so e.g. the clinical_audit_events hash-chain
-- trigger (migration 282) sees the already-resolved NEW.tenant_id. No new
-- moving parts, no per-table trigger sprawl.
--
-- SCOPE. We rewrite the DEFAULT for the tenant_id column of EXACTLY the set of
-- base tables that carry both a non-dropped `tenant_id` column AND a
-- `tenant_isolation` policy (the policied PHI set 075/236/238/239/304 built).
-- Discovered dynamically from the catalog so this migration cannot drift from
-- the policy set: any table that is policied gets the GUC default; any table
-- that is NOT policied (global reference/terminology/catalog tables carry no
-- tenant_id at all, so they are never in this set) is left untouched. Tables
-- that have a tenant_id column but no tenant_isolation policy are intentionally
-- skipped — without the WITH CHECK there is no 42501 to fix, and changing
-- their default would be out of scope for B1.2.
--
-- IDEMPOTENT. ALTER COLUMN ... SET DEFAULT is naturally idempotent (re-setting
-- the same expression is a no-op rewrite of pg_attrdef, no table rewrite — a
-- DEFAULT change never rewrites existing rows). Re-running is safe and fast.
-- The audit stamp is guarded by a NOT EXISTS, mirroring 075 / 304.

BEGIN;

-- ---------------------------------------------------------------------------
-- Rewrite the DEFAULT on tenant_id for every policied base table so the
-- default reads the request tenant from the GUC, falling back to the default
-- tenant when unset/''/'bypass'. Dollar-quoted format string ($fmt$ … $fmt$)
-- so the single-quoted literals inside the expression need no escaping.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  altered int := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid
                         AND a.attname = 'tenant_id'
                         AND NOT a.attisdropped
     WHERE c.relkind = 'r'
       AND EXISTS (
         SELECT 1 FROM pg_policy p
          WHERE p.polrelid = c.oid
            AND p.polname = 'tenant_isolation'
       )
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      $fmt$ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, '00000000-0000-4000-8000-000000000001'::uuid)$fmt$,
      t
    );
    altered := altered + 1;
  END LOOP;

  RAISE NOTICE 'migration 310: rewrote tenant_id DEFAULT to GUC-reading expression on % policied table(s)', altered;
END
$$;

-- ---------------------------------------------------------------------------
-- Audit trail (idempotent — mirrors the 075 / 236 / 239 / 272 / 304 stamp).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_ID_GUC_DEFAULT_APPLIED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '310_tenant_id_guc_default.sql',
    'workstream', 'WS1 B1.2 — multi-tenant INSERT completion',
    'strategy', 'data-driven loop over every base table with a tenant_id column AND a tenant_isolation policy; ALTER COLUMN tenant_id SET DEFAULT to a GUC-reading COALESCE(NULLIF(NULLIF(current_setting(...),''),''bypass'')::uuid, default_tenant)',
    'finding', 'policied tenant_id columns defaulted to the LITERAL default tenant, so an INSERT under setTenant(non-default) that omitted tenant_id failed the WITH CHECK with 42501',
    'guc', 'app.current_tenant_id',
    'fallback_tenant', '00000000-0000-4000-8000-000000000001',
    'unaffected', 'inserts that set tenant_id explicitly; single-tenant (default) inserts; non-policied tables'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_ID_GUC_DEFAULT_APPLIED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);

COMMIT;
