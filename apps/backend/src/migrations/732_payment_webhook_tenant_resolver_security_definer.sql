-- 732: owner-owned SECURITY DEFINER resolver for the public payment-gateway
-- webhook mount, so token->tenant routing survives migration 726's fail-closed
-- restrictive RLS under the real production DB role.
--
-- WHY THIS IS NEEDED (availability, not isolation).
-- 726 put payment_gateway_provider_configs under ENABLE + FORCE + an
-- AS RESTRICTIVE policy that requires a present, non-empty, non-'bypass'
-- tenant GUC matching the row. The public webhook route (/webhooks/payments,
-- mounted BEFORE the tenant middleware) must resolve the tenant FROM the row
-- before any tenant context can exist: the URL's opaque token is the only
-- routing key and the tenant is unknown until the config row is read
-- (paymentGatewayService.resolveWebhookConfigByToken). Under the prod runtime
-- role vhhealth_runtime (NOSUPERUSER / NOBYPASSRLS — cluster.yaml managed.roles)
-- that cross-tenant lookup on a plain connection matches zero rows and every
-- provider delivery 404s. This is an availability defect, not a leak: 726 is
-- fail-closed and never widened isolation.
--
-- THE FIX, AND WHY IT DOES NOT WEAKEN ISOLATION.
-- A single narrow SECURITY DEFINER function owned by the migration owner
-- `vhhealth` (which carries BYPASSRLS on the migration path ONLY — cluster.yaml
-- documents this, and the runtime role stays NOBYPASSRLS) performs exactly the
-- token equality lookup and returns ONLY the two columns needed to identify the
-- tenant: tenant_id and the config row id. It returns no secrets, no metadata,
-- no provider credentials. The caller then re-reads the full config row inside
-- a proper setTenantTx(tenant_id) transaction, where 726's policy matches on the
-- resolved tenant and the read is once again tenant-scoped. The runtime role is
-- granted EXECUTE on this one function only; it is NOT granted broad table
-- access, and the restrictive policy on the table is untouched.
--
-- Defense in depth:
--   * search_path is locked (pg_catalog, public) so the definer body cannot be
--     hijacked by a caller-set search_path.
--   * an owner-privilege assertion fails the migration loudly if the function
--     owner is somehow neither superuser nor BYPASSRLS (in which case the
--     definer would silently NOT bypass and the resolver would be a no-op) —
--     same guard idiom migration 663 uses for its authority functions.
--   * EXECUTE is REVOKEd from PUBLIC and granted only to the app roles.
--
-- The token itself is a 16-64 char opaque secret validated by the route before
-- this function is ever called; possession of it is already the provider's
-- authentication factor for the mount.

CREATE OR REPLACE FUNCTION public.resolve_payment_webhook_tenant(p_webhook_token TEXT)
RETURNS TABLE (tenant_id UUID, config_id INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $resolve_payment_webhook_tenant$
  SELECT c.tenant_id, c.id
    FROM public.payment_gateway_provider_configs AS c
   WHERE c.metadata->>'webhook_token' = p_webhook_token
   LIMIT 1;
$resolve_payment_webhook_tenant$;

-- Prove the definer will actually bypass RLS. If the owner is not privileged
-- the resolver silently returns nothing under FORCE RLS, which would reintroduce
-- the exact 404 this migration fixes — fail the apply instead.
DO $resolve_payment_webhook_tenant_owner$
DECLARE
  owner_is_privileged BOOLEAN;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO owner_is_privileged
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_roles AS role ON role.oid = routine.proowner
   WHERE routine.oid = 'public.resolve_payment_webhook_tenant(TEXT)'::REGPROCEDURE;

  IF NOT COALESCE(owner_is_privileged, FALSE) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'resolve_payment_webhook_tenant owner must be superuser or BYPASSRLS';
  END IF;
END
$resolve_payment_webhook_tenant_owner$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.resolve_payment_webhook_tenant(TEXT)
  FROM PUBLIC;

DO $resolve_payment_webhook_tenant_grants$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.resolve_payment_webhook_tenant(TEXT) TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$resolve_payment_webhook_tenant_grants$;

COMMENT ON FUNCTION public.resolve_payment_webhook_tenant(TEXT) IS
  'Owner-owned SECURITY DEFINER token->tenant resolver for the pre-tenant payment webhook mount (migration 732). Returns only tenant_id + config id; the route re-reads the full row under setTenantTx. Locked search_path; EXECUTE limited to the app roles.';
