-- Migration 670: durable run receipts for fleet-scope scheduled jobs.
--
-- 668 gave every tenant-fanned cron a durable receipt in scheduled_job_runs.
-- The crons that sweep the whole fleet in a single pass could not be recorded
-- there at all: audit-chain verification enumerates tenants itself (with the
-- default tenant as a floor) and results-inbox escalation only visits tenants
-- that own an active task-scope rule, so neither has a discovery step that
-- 668's row shape can describe. `scheduled_job_runs_final_state_ck` accepts a
-- terminal 'succeeded' only when discovery succeeded over at least one tenant,
-- and `scheduled_job_runs_discovery_count_ck` forbids a non-zero
-- tenants_discovered without it. Recording a fleet sweep as a one-tenant
-- fan-out would be a fabricated count, so those jobs ran with no durable
-- evidence at all — and withJobLock (src/utils/scheduler.js) logs and swallows
-- their throw, which left a tick that never fired indistinguishable from a
-- tick that failed.
--
-- This adds a scope discriminator plus a second, mutually exclusive row shape.
-- Tenant fan-out rows keep every constraint 668 gave them, verbatim. Fleet
-- rows carry no tenant dimension: discovery stays 'pending' because there is
-- nothing to discover, all four tenant counters stay 0, and no
-- scheduled_job_tenant_runs child may exist — already enforced by the existing
-- scheduled_job_run_finalization_guard, which rejects any child row on a run
-- whose discovery_status is not 'succeeded'.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.scheduled_job_runs
  ADD COLUMN scope VARCHAR(24) NOT NULL DEFAULT 'tenant_fanout';

ALTER TABLE public.scheduled_job_runs
  ADD CONSTRAINT scheduled_job_runs_scope_ck
  CHECK (scope IN ('tenant_fanout', 'fleet'));

-- 'job_failed' is the fleet counterpart of the fan-out failure states: the job
-- body itself threw. It is unreachable for tenant_fanout rows because the
-- fan-out branch of the state check below does not list it.
ALTER TABLE public.scheduled_job_runs
  DROP CONSTRAINT scheduled_job_runs_aggregate_status_ck;

ALTER TABLE public.scheduled_job_runs
  ADD CONSTRAINT scheduled_job_runs_aggregate_status_ck
  CHECK (aggregate_status IN (
    'running', 'succeeded', 'partial_failure', 'evidence_failure',
    'reconciliation_failed', 'discovery_failed', 'abandoned', 'job_failed'
  ));

ALTER TABLE public.scheduled_job_runs
  DROP CONSTRAINT scheduled_job_runs_final_state_ck;

ALTER TABLE public.scheduled_job_runs
  ADD CONSTRAINT scheduled_job_runs_final_state_ck
  CHECK (
    (
      scope = 'tenant_fanout'
      AND (
        aggregate_status = 'running'
        OR (
          aggregate_status = 'succeeded'
          AND discovery_status = 'succeeded'
          AND tenants_failed = 0
          AND tenants_unresolved = 0
          AND tenants_succeeded = tenants_discovered
          AND failure_code IS NULL
        )
        OR (
          aggregate_status = 'partial_failure'
          AND discovery_status = 'succeeded'
          AND tenants_failed > 0
          AND tenants_unresolved = 0
          AND tenants_succeeded + tenants_failed = tenants_discovered
          AND failure_code IS NOT NULL
        )
        OR (
          aggregate_status = 'evidence_failure'
          AND discovery_status = 'succeeded'
          AND tenants_unresolved > 0
          AND tenants_succeeded + tenants_failed + tenants_unresolved = tenants_discovered
          AND failure_code IS NOT NULL
        )
        OR (
          aggregate_status = 'reconciliation_failed'
          AND discovery_status = 'pending'
          AND tenants_discovered = 0
          AND tenants_succeeded = 0
          AND tenants_failed = 0
          AND tenants_unresolved = 0
          AND failure_code IS NOT NULL
        )
        OR (
          aggregate_status = 'discovery_failed'
          AND discovery_status = 'failed'
          AND tenants_discovered = 0
          AND tenants_succeeded = 0
          AND tenants_failed = 0
          AND tenants_unresolved = 0
          AND failure_code IS NOT NULL
        )
        OR (
          aggregate_status = 'abandoned'
          AND failure_code IS NOT NULL
          AND (
            (
              discovery_status = 'pending'
              AND tenants_discovered = 0
              AND tenants_succeeded = 0
              AND tenants_failed = 0
              AND tenants_unresolved = 0
            )
            OR (
              discovery_status = 'succeeded'
              AND tenants_succeeded + tenants_failed + tenants_unresolved = tenants_discovered
            )
          )
        )
      )
    )
    OR (
      scope = 'fleet'
      AND discovery_status = 'pending'
      AND tenants_discovered = 0
      AND tenants_succeeded = 0
      AND tenants_failed = 0
      AND tenants_unresolved = 0
      AND (
        (aggregate_status IN ('running', 'succeeded') AND failure_code IS NULL)
        OR (
          aggregate_status IN ('job_failed', 'reconciliation_failed', 'abandoned')
          AND failure_code IS NOT NULL
        )
      )
    )
  );

COMMENT ON COLUMN public.scheduled_job_runs.scope IS
  'tenant_fanout = one row per runForEachTenant tick, with per-tenant children; '
  'fleet = one row per single-pass fleet sweep, which has no tenant dimension and '
  'must never own a scheduled_job_tenant_runs child.';

COMMIT;
