-- 726: fail-closed restrictive RLS for the webhook-fed PHI and financial
-- tables added after migration 669.
--
-- The 2026-08-23 once-over found the fail-closed layering practice (the
-- 605/609/669 explicit-context template) stopped at 669: every tenant-scoped
-- table added in 677-725 carries only the permissive 075-style policy, whose
-- four-way OR shows ALL rows to a connection with no tenant GUC. Writers are
-- disciplined today (abdmHiuService and paymentGatewayService run under
-- setTenant transactions), but these particular tables are populated by
-- EXTERNAL callbacks (ABDM gateway webhooks, payment-provider webhooks) and
-- hold either PHI bundles or financial state — exactly where defense in depth
-- must not depend on every future call site remembering the wrapper.
--
-- CORRECTION (re-audit 2026-08-25): the claim just below — that every writer of
-- these tables "runs under setTenant transactions" — was FALSE when this file
-- shipped. The PUBLIC pre-tenant mounts (payment webhook intake, ABDM Scan&Share
-- intake, HIU on-request ack) and the three cross-tenant expiry sweeps ran on
-- plain prisma with no tenant GUC, so under the prod NOBYPASSRLS runtime role
-- this fail-closed tranche 404'd/42501'd/silently no-op'd those paths. Migrations
-- 732 (owner-owned SECURITY DEFINER token resolver) and 733 (system-job sweep
-- predicate), plus setTenantTx/setSystemJobTx wrapping of those call sites, close
-- the gap WITHOUT weakening isolation. The description below is retained as the
-- original intent; treat "all setTenantTx" as the goal 732/733 actually deliver.
--
-- This tranche deliberately covers ONLY the webhook/callback-fed PHI and
-- financial tables whose writers are verified to run under explicit tenant
-- transactions (abdmHiuService, abhaEnrolmentService, abdmShareIntakeService,
-- paymentGatewayService — all setTenantTx). The operational 677+ tables (SOS,
-- shift-swap/on-call, ambulance positions, pharmacy counter sales, dietary
-- tickets) AND the SMS config pair (whose smsProviderConfigService does not
-- yet wrap) stay on the documented request-path-permissive posture — see
-- prisma/SCHEMA_NOTES.md ("RLS posture for 677+ operational tables").
--
-- Template is the 669 loop verbatim: ENABLE + FORCE (owner exemption removed)
-- plus an AS RESTRICTIVE policy requiring a present, non-empty, non-'bypass'
-- tenant GUC that matches the row. Restrictive policies AND with the existing
-- permissive tenant_isolation policies, which are left untouched.
--
-- Test impact is intentional: any suite touching these tables directly must
-- run its statements under an explicit tenant context (setTenant or a
-- transaction-local set_config), same as the 605/609/669 suites.

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'abdm_hiu_fetch_sessions',
    'abdm_hiu_fetch_pages',
    'abdm_hiu_received_bundles',
    'abdm_patient_share_intakes',
    'abha_enrolment_sessions',
    'payment_gateway_orders',
    'payment_gateway_webhook_events',
    'payment_gateway_refunds',
    'payment_gateway_provider_configs'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS webhook_financial_explicit_tenant_context ON public.%I', table_name);
    EXECUTE format($policy$
      CREATE POLICY webhook_financial_explicit_tenant_context ON public.%I
        AS RESTRICTIVE
        USING (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = app_current_tenant_id_uuid()
        )
    $policy$, table_name);
  END LOOP;
END
$$;
