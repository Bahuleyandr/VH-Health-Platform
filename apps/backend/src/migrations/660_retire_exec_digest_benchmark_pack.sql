-- 660_retire_exec_digest_benchmark_pack.sql
--
-- Audit #3 P10: retire the deploy-held executive digest and benchmark-pack
-- substrate after its only service was removed. The tables have no remaining
-- runtime reader or writer; keeping them would leave an undocumented dormant
-- surface that can be revived without the intended governance workflow.
--
-- This migration deliberately uses the runner's default single transaction.
-- Existing data is retained unless an operator supplies separate archive or
-- retention authority and clears the tables before retrying this migration.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  target_table TEXT;
  has_rows BOOLEAN;
  target_tables CONSTANT TEXT[] := ARRAY[
    'analytics_exec_digest_deliveries',
    'analytics_exec_digest_subscriptions',
    'analytics_exec_digest_settings',
    'analytics_benchmark_pack_exports'
  ];
BEGIN
  -- Acquire every required lock before checking or dropping any table. The
  -- locks remain held through the runner-managed transaction.
  FOREACH target_table IN ARRAY target_tables LOOP
    IF to_regclass(format('public.%I', target_table)) IS NOT NULL THEN
      EXECUTE format(
        'LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',
        target_table
      );
    END IF;
  END LOOP;

  FOREACH target_table IN ARRAY target_tables LOOP
    IF to_regclass(format('public.%I', target_table)) IS NOT NULL THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)',
        target_table
      ) INTO has_rows;

      IF has_rows THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P10D1',
          MESSAGE = 'AUDIT3_P10_DEAD_SURFACE_DATA_PRESENT',
          DETAIL = format(
            'Refusing to retire populated table public.%I.',
            target_table
          ),
          HINT = 'Obtain explicit retention or archive authority before clearing this table and retrying the migration.';
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS public.analytics_exec_digest_deliveries;
DROP TABLE IF EXISTS public.analytics_exec_digest_subscriptions;
DROP TABLE IF EXISTS public.analytics_exec_digest_settings;
DROP TABLE IF EXISTS public.analytics_benchmark_pack_exports;
