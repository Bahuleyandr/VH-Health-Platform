-- 733: let the legitimate cross-tenant expiry sweeps run under migration 726's
-- fail-closed restrictive RLS WITHOUT re-opening the broad admin 'bypass' path.
--
-- WHY THIS IS NEEDED (availability, not isolation).
-- Three scheduled sweeps legitimately span every tenant:
--   * abhaEnrolmentService.sweepExpiredEnrolmentSessions  (abha_enrolment_sessions)
--   * abdmShareIntakeService.sweepExpiredShareIntakes     (abdm_patient_share_intakes)
--   * paymentGatewayService.expireStaleGatewayOrders      (payment_gateway_orders)
-- They run outside any request, under the scheduler's advisory job lock. Before
-- 726 they relied on the permissive tenant_isolation policy's 'bypass' branch
-- (runWithSuperAdmin sets app.current_tenant_id = 'bypass'). Migration 726 added
-- an AS RESTRICTIVE policy that explicitly REJECTS 'bypass', so post-726 every
-- one of these sweeps silently matches zero rows — the ABHA one-live-session
-- partial unique then wedges a patient behind an abandoned OTP txn, stale share
-- intakes pile on the front desk, and 'created' gateway orders never expire.
--
-- THE FIX, AND WHY IT DOES NOT WEAKEN ISOLATION.
-- We do NOT re-admit 'bypass' — that GUC is reachable from any admin/superadmin
-- read path (runWithSuperAdmin) and re-opening it would undo 726's whole point.
-- Instead we add a SEPARATE, purpose-built predicate keyed to a distinct GUC,
-- app.rls_system_job = 'cross_tenant_sweep', and recreate 726's restrictive
-- policy on ONLY these three swept tables so it also passes when that GUC is
-- present. The six other 726 tables are left exactly as 726 wrote them.
--
-- The isolation argument for the new GUC:
--   * It is emitted ONLY by lib/prisma.js setSystemJobTx(), a transaction-local
--     set_config(..., true) that auto-clears at COMMIT/ROLLBACK (no pooled-
--     connection leak). setSystemJobTx is called ONLY by the three cross-tenant
--     sweep functions above, each invoked ONLY from the scheduler's withJobLock
--     crons. No request-path code sets it and no user input decides whether it
--     is set — the sentinel is a compile-time constant known only to server code.
--   * A request-scoped connection can never carry it: nothing on the request
--     path calls setSystemJobTx, and the value cannot be smuggled through a
--     tenant id (it is a different GUC name entirely).
--   * It grants no more reach than the sweeps already need — cross-tenant read +
--     the single status UPDATE each sweep performs — and it does so on exactly
--     three tables, not the whole tranche.
-- Net: this STRENGTHENS the posture versus the pre-726 'bypass' reliance, because
-- the cross-tenant reach is now scoped to a system-job-only GUC on three tables
-- rather than the broad admin bypass on all of them.

DO $webhook_financial_system_job_policy$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'abha_enrolment_sessions',
    'abdm_patient_share_intakes',
    'payment_gateway_orders'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS webhook_financial_explicit_tenant_context ON public.%I', table_name);
    EXECUTE format($policy$
      CREATE POLICY webhook_financial_explicit_tenant_context ON public.%I
        AS RESTRICTIVE
        USING (
          (
            current_setting('app.current_tenant_id', true) IS NOT NULL
            AND current_setting('app.current_tenant_id', true) <> ''
            AND current_setting('app.current_tenant_id', true) <> 'bypass'
            AND tenant_id = app_current_tenant_id_uuid()
          )
          OR current_setting('app.rls_system_job', true) = 'cross_tenant_sweep'
        )
        WITH CHECK (
          (
            current_setting('app.current_tenant_id', true) IS NOT NULL
            AND current_setting('app.current_tenant_id', true) <> ''
            AND current_setting('app.current_tenant_id', true) <> 'bypass'
            AND tenant_id = app_current_tenant_id_uuid()
          )
          OR current_setting('app.rls_system_job', true) = 'cross_tenant_sweep'
        )
    $policy$, table_name);
  END LOOP;
END
$webhook_financial_system_job_policy$;
