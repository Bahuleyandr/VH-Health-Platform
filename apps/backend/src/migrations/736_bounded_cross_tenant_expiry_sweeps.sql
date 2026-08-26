-- 736: replace the caller-settable system-job GUC with three bounded owner
-- capabilities for the legitimate fleet-wide expiry transitions.
--
-- Migration 733 admitted app.rls_system_job='cross_tenant_sweep' through the
-- restrictive policy on three tables. A custom GUC is not a credential: any
-- SQL-capable runtime session can set the same literal and then issue arbitrary
-- cross-tenant reads or writes allowed by its table grants. Restore migration
-- 726's explicit-tenant-only policy and expose only the exact transitions the
-- scheduler needs as parameterless SECURITY DEFINER routines.
--
-- Deployment invariant: the PreSync migration connection is the table owner
-- `vhhealth` with BYPASSRLS (GO_LIVE_ACTIVATION_CHECKLIST D1/D2 and the
-- wait-owner-bypassrls initContainer). The assertion below fails loudly if that
-- invariant is absent; SET row_security=off also turns later owner-role drift
-- into an error instead of a silent zero-row sweep under FORCE RLS.

DO $bounded_sweep_restore_explicit_tenant_policy$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'abha_enrolment_sessions',
    'abdm_patient_share_intakes',
    'payment_gateway_orders'
  ]::TEXT[] LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS webhook_financial_explicit_tenant_context ON public.%I',
      table_name
    );
    EXECUTE pg_catalog.format($policy$
      CREATE POLICY webhook_financial_explicit_tenant_context ON public.%I
        AS RESTRICTIVE
        USING (
          pg_catalog.current_setting('app.current_tenant_id', true) IS NOT NULL
          AND pg_catalog.current_setting('app.current_tenant_id', true) <> ''
          AND pg_catalog.current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = public.app_current_tenant_id_uuid()
        )
        WITH CHECK (
          pg_catalog.current_setting('app.current_tenant_id', true) IS NOT NULL
          AND pg_catalog.current_setting('app.current_tenant_id', true) <> ''
          AND pg_catalog.current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = public.app_current_tenant_id_uuid()
        )
    $policy$, table_name);
  END LOOP;
END
$bounded_sweep_restore_explicit_tenant_policy$;

DROP FUNCTION IF EXISTS public.sweep_expired_abha_enrolment_sessions();
CREATE FUNCTION public.sweep_expired_abha_enrolment_sessions()
RETURNS INTEGER
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $sweep_expired_abha_enrolment_sessions$
  WITH expired AS (
    UPDATE public.abha_enrolment_sessions AS session
       SET status = 'expired',
           verification_claim_id = NULL,
           verification_claimed_at = NULL,
           resend_claim_id = NULL,
           resend_claimed_at = NULL,
           updated_at = pg_catalog.now()
     WHERE session.status IN ('initiated', 'otp_sent', 'otp_verifying', 'otp_verified')
       AND session.expires_at IS NOT NULL
       AND session.expires_at < pg_catalog.now()
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::INTEGER FROM expired;
$sweep_expired_abha_enrolment_sessions$;

DROP FUNCTION IF EXISTS public.sweep_expired_abdm_share_intakes();
CREATE FUNCTION public.sweep_expired_abdm_share_intakes()
RETURNS INTEGER
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $sweep_expired_abdm_share_intakes$
  WITH expired AS (
    UPDATE public.abdm_patient_share_intakes AS intake
       SET status = 'expired',
           updated_at = pg_catalog.now()
     WHERE intake.status = 'received'
       AND intake.expires_at IS NOT NULL
       AND intake.expires_at < pg_catalog.now()
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::INTEGER FROM expired;
$sweep_expired_abdm_share_intakes$;

DROP FUNCTION IF EXISTS public.sweep_expired_payment_gateway_orders();
CREATE FUNCTION public.sweep_expired_payment_gateway_orders()
RETURNS INTEGER
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $sweep_expired_payment_gateway_orders$
  WITH expired AS (
    UPDATE public.payment_gateway_orders AS gateway_order
       SET status = 'expired',
           updated_at = pg_catalog.now()
     WHERE gateway_order.status IN ('created', 'attempted')
       AND gateway_order.expires_at IS NOT NULL
       AND gateway_order.expires_at < pg_catalog.now()
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::INTEGER FROM expired;
$sweep_expired_payment_gateway_orders$;

DO $bounded_sweep_owner_invariant$
DECLARE
  routine_signature TEXT;
  routine_owner NAME;
  owner_is_privileged BOOLEAN;
BEGIN
  FOREACH routine_signature IN ARRAY ARRAY[
    'public.sweep_expired_abha_enrolment_sessions()',
    'public.sweep_expired_abdm_share_intakes()',
    'public.sweep_expired_payment_gateway_orders()'
  ]::TEXT[] LOOP
    SELECT role.rolname, role.rolsuper OR role.rolbypassrls
      INTO routine_owner, owner_is_privileged
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_roles AS role ON role.oid = routine.proowner
     WHERE routine.oid = routine_signature::pg_catalog.regprocedure;

    IF routine_owner IS DISTINCT FROM CURRENT_USER
       OR NOT COALESCE(owner_is_privileged, FALSE) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = pg_catalog.format(
          '%s must be owned by the PreSync migration role with SUPERUSER or BYPASSRLS (D1/D2)',
          routine_signature
        );
    END IF;
  END LOOP;
END
$bounded_sweep_owner_invariant$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.sweep_expired_abha_enrolment_sessions()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.sweep_expired_abdm_share_intakes()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.sweep_expired_payment_gateway_orders()
  FROM PUBLIC;

DO $bounded_sweep_runtime_grants$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.sweep_expired_abha_enrolment_sessions() TO %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.sweep_expired_abdm_share_intakes() TO %I',
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.sweep_expired_payment_gateway_orders() TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$bounded_sweep_runtime_grants$;

COMMENT ON FUNCTION public.sweep_expired_abha_enrolment_sessions() IS
  'Parameterless owner capability: expire only stale live ABHA enrolment sessions and clear verification/resend claims. Runtime EXECUTE only; no direct cross-tenant table access.';
COMMENT ON FUNCTION public.sweep_expired_abdm_share_intakes() IS
  'Parameterless owner capability: expire only stale received ABDM share intakes. Runtime EXECUTE only; no direct cross-tenant table access.';
COMMENT ON FUNCTION public.sweep_expired_payment_gateway_orders() IS
  'Parameterless owner capability: expire only stale created/attempted gateway orders. Runtime EXECUTE only; no direct cross-tenant table access.';
