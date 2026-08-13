-- Migration 672: make the tenant-KEK immutability guard version-aware so a
-- crypto-shredded tenant can be re-provisioned without ever replacing key
-- material in place.
--
-- 669 added `payroll_tenant_kek_replacement_guard` because silently swapping the
-- material behind `t:<tenant>:v1` strands every payload already wrapped under
-- the old key: the key id is stamped into each enc:v2 envelope, so the same id
-- must mean the same key forever.  That property is right and this migration
-- keeps it.  What 669 shipped could not hold it, and left no way back:
--
--   1. The predicate required BOTH old and new material to be NOT NULL, so the
--      two-step `material -> NULL` (crypto-shred) then `NULL -> new material`
--      was permitted.  That is in-place replacement of v1 with an extra step —
--      exactly what the guard exists to forbid.
--   2. It only ever looked at `t:<tenant>:v1`, so any later version was
--      unguarded — the guard would have stopped protecting the moment a real
--      rotation happened.
--   3. Because the provider had no versioned path either (it reused the v1 row
--      or threw), a deliberate crypto-shred became a one-way door: the shredded
--      tenant could not be re-provisioned by code, and the only by-hand repair
--      was the in-place UPDATE this trigger rejects.
--
-- The sanctioned path after this migration: a shred clears the material of every
-- `t:<tenant>:v<n>` row and retires it; re-provisioning INSERTS the next version
-- (`v<n+1>`) with fresh random material and points `rotated_from` at the row it
-- succeeds.  New writes stamp the highest active version; old payloads keep
-- naming the version that wrapped them, so nothing is stranded and shredded
-- material stays unrecoverable.
--
-- The guard therefore becomes: for any tenant KEK version, `wrapped_key_material`
-- may only ever move from set -> NULL (the shred).  Replacing it, or refilling a
-- shredded row, is refused.  INSERTs are untouched (that is the rotation path)
-- and non-tenant key ids (continuity pack signing keys, downtime snapshot keys)
-- are untouched.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.guard_payroll_tenant_kek_replacement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Any version of a per-tenant KEK, not just v1.
  IF OLD.tenant_id IS NOT NULL
     AND OLD.key_id ~ ('^t:' || OLD.tenant_id::text || ':v[0-9]+$')
     AND OLD.wrapped_key_material IS DISTINCT FROM NEW.wrapped_key_material
     AND NEW.wrapped_key_material IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'tenant KEK material is immutable; provision the next t:<tenant>:v<n> version instead of replacing or refilling one',
      DETAIL = format(
        'key_id %s already denotes fixed key material (currently %s); a crypto-shred may only clear it',
        OLD.key_id,
        CASE WHEN OLD.wrapped_key_material IS NULL THEN 'cleared by crypto-shred' ELSE 'present' END
      ),
      HINT = 'INSERT a new t:<tenant>:v<n+1> row (see provisionTenantKek / scripts/onboard-tenant.mjs)';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_payroll_tenant_kek_replacement() IS
  'Per-tenant KEK material is write-once: it may only be cleared (crypto-shred), never replaced '
  'or refilled. Re-provisioning inserts the next t:<tenant>:v<n> version instead.';

-- Trigger definition is unchanged (BEFORE UPDATE OF wrapped_key_material, from
-- 669); only the function body it calls is replaced. Re-asserted here so a
-- database that somehow lost the trigger gets it back with the new body.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'payroll_tenant_kek_replacement_guard'
       AND tgrelid = 'public.encryption_keys'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER payroll_tenant_kek_replacement_guard
    BEFORE UPDATE OF wrapped_key_material ON public.encryption_keys
    FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_tenant_kek_replacement();
  END IF;
END
$$;

COMMIT;
