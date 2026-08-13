-- Migration 668: truthful tenant fan-out receipts and scheduled-notification
-- tenant ownership.

BEGIN;

-- A scheduler run is a fleet-level operational fact. Tenant-specific outcomes
-- live in the child table and are protected by forced, explicit-context RLS.
CREATE TABLE public.scheduled_job_runs (
  id BIGSERIAL PRIMARY KEY,
  job_label VARCHAR(160) NOT NULL,
  lock_key VARCHAR(160) NOT NULL,
  discovery_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  aggregate_status VARCHAR(24) NOT NULL DEFAULT 'running',
  tenants_discovered INTEGER NOT NULL DEFAULT 0,
  tenants_succeeded INTEGER NOT NULL DEFAULT 0,
  tenants_failed INTEGER NOT NULL DEFAULT 0,
  tenants_unresolved INTEGER NOT NULL DEFAULT 0,
  failure_code VARCHAR(80),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT scheduled_job_runs_label_ck
    CHECK (job_label = BTRIM(job_label) AND LENGTH(job_label) BETWEEN 1 AND 160),
  CONSTRAINT scheduled_job_runs_lock_key_ck
    CHECK (lock_key = BTRIM(lock_key) AND LENGTH(lock_key) BETWEEN 1 AND 160),
  CONSTRAINT scheduled_job_runs_discovery_status_ck
    CHECK (discovery_status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT scheduled_job_runs_aggregate_status_ck
    CHECK (aggregate_status IN (
      'running', 'succeeded', 'partial_failure', 'evidence_failure',
      'reconciliation_failed', 'discovery_failed', 'abandoned'
    )),
  CONSTRAINT scheduled_job_runs_counts_ck
    CHECK (
      tenants_discovered >= 0
      AND tenants_succeeded >= 0
      AND tenants_failed >= 0
      AND tenants_unresolved >= 0
      AND tenants_succeeded + tenants_failed + tenants_unresolved <= tenants_discovered
    ),
  CONSTRAINT scheduled_job_runs_discovery_count_ck
    CHECK (
      (discovery_status = 'succeeded' AND tenants_discovered > 0)
      OR (discovery_status IN ('pending', 'failed') AND tenants_discovered = 0)
    ),
  CONSTRAINT scheduled_job_runs_completion_ck
    CHECK (
      (aggregate_status = 'running' AND finished_at IS NULL)
      OR (aggregate_status <> 'running' AND finished_at IS NOT NULL)
    ),
  CONSTRAINT scheduled_job_runs_final_state_ck
    CHECK (
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
);

CREATE INDEX idx_scheduled_job_runs_label_started
  ON public.scheduled_job_runs (job_label, started_at DESC);

CREATE INDEX idx_scheduled_job_runs_running_started
  ON public.scheduled_job_runs (started_at, id)
  WHERE aggregate_status = 'running';

CREATE INDEX idx_scheduled_job_runs_finished_retention
  ON public.scheduled_job_runs (finished_at, id)
  WHERE aggregate_status <> 'running';

CREATE TABLE public.scheduled_job_tenant_runs (
  run_id BIGINT NOT NULL,
  tenant_id UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  failure_code VARCHAR(80),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, tenant_id),
  CONSTRAINT scheduled_job_tenant_runs_run_fk
    FOREIGN KEY (run_id)
    REFERENCES public.scheduled_job_runs(id)
    ON DELETE CASCADE,
  CONSTRAINT scheduled_job_tenant_runs_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES public.tenants(id)
    ON DELETE RESTRICT,
  CONSTRAINT scheduled_job_tenant_runs_status_ck
    CHECK (status IN ('running', 'succeeded', 'failed', 'indeterminate')),
  CONSTRAINT scheduled_job_tenant_runs_completion_ck
    CHECK (
      (status = 'running' AND finished_at IS NULL AND failure_code IS NULL)
      OR (status = 'succeeded' AND finished_at IS NOT NULL AND failure_code IS NULL)
      OR (status = 'failed' AND finished_at IS NOT NULL AND failure_code IS NOT NULL)
      OR (status = 'indeterminate' AND finished_at IS NOT NULL AND failure_code IS NOT NULL)
    )
);

CREATE INDEX idx_scheduled_job_tenant_runs_tenant_started
  ON public.scheduled_job_tenant_runs (tenant_id, started_at DESC);

ALTER TABLE public.scheduled_job_tenant_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_job_tenant_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.scheduled_job_tenant_runs
  FOR ALL
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

CREATE POLICY scheduled_job_tenant_runs_explicit_context
  ON public.scheduled_job_tenant_runs
  AS RESTRICTIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

CREATE OR REPLACE FUNCTION public.scheduled_job_run_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
       OR current_user = pg_catalog.pg_get_userbyid(
         (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID)
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'scheduled job run evidence is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_run_delete_guard';
  END IF;
  IF OLD.aggregate_status <> 'running' THEN
    RAISE EXCEPTION 'scheduled job run % is already final', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_run_final_immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.job_label IS DISTINCT FROM OLD.job_label
     OR NEW.lock_key IS DISTINCT FROM OLD.lock_key
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'scheduled job run identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_run_identity_immutable';
  END IF;
  IF OLD.discovery_status <> 'pending'
     AND (
       NEW.discovery_status IS DISTINCT FROM OLD.discovery_status
       OR NEW.tenants_discovered IS DISTINCT FROM OLD.tenants_discovered
     ) THEN
    RAISE EXCEPTION 'scheduled job discovery evidence is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_run_discovery_immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.scheduled_job_run_finalization_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  child_total integer;
  child_running integer;
  child_succeeded integer;
  child_failed integer;
  child_indeterminate integer;
BEGIN
  IF NEW.aggregate_status = 'running' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE status = 'running')::integer,
         COUNT(*) FILTER (WHERE status = 'succeeded')::integer,
         COUNT(*) FILTER (WHERE status = 'failed')::integer,
         COUNT(*) FILTER (WHERE status = 'indeterminate')::integer
    INTO child_total, child_running, child_succeeded, child_failed, child_indeterminate
    FROM public.scheduled_job_tenant_runs
   WHERE run_id = NEW.id;

  IF child_running <> 0
     OR child_succeeded <> NEW.tenants_succeeded
     OR child_failed <> NEW.tenants_failed
     OR child_indeterminate > NEW.tenants_unresolved
     OR child_total > NEW.tenants_discovered
     OR (
       NEW.aggregate_status IN ('succeeded', 'partial_failure')
       AND (
         child_indeterminate <> 0
         OR child_total <> NEW.tenants_discovered
       )
     )
     OR (
       NEW.discovery_status <> 'succeeded'
       AND child_total <> 0
     ) THEN
    RAISE EXCEPTION 'scheduled job run final state does not match tenant receipts'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_run_child_truth_guard';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_scheduled_job_run_finalization_guard
  BEFORE UPDATE ON public.scheduled_job_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.scheduled_job_run_finalization_guard();

DO $scheduled_job_finalizer_owner$
DECLARE
  owner_is_privileged boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO owner_is_privileged
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_roles AS role ON role.oid = routine.proowner
   WHERE routine.oid = 'public.scheduled_job_run_finalization_guard()'::pg_catalog.regprocedure;

  IF NOT COALESCE(owner_is_privileged, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'scheduled_job_run_finalization_guard owner must be superuser or BYPASSRLS';
  END IF;
END
$scheduled_job_finalizer_owner$;

CREATE TRIGGER trg_scheduled_job_run_transition_guard
  BEFORE UPDATE OR DELETE ON public.scheduled_job_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.scheduled_job_run_transition_guard();

CREATE OR REPLACE FUNCTION public.scheduled_job_tenant_run_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  parent_aggregate_status text;
  parent_discovery_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT parent.aggregate_status, parent.discovery_status
      INTO parent_aggregate_status, parent_discovery_status
      FROM public.scheduled_job_runs AS parent
     WHERE parent.id = NEW.run_id
     FOR UPDATE;
    IF parent_aggregate_status IS DISTINCT FROM 'running'
       OR parent_discovery_status IS DISTINCT FROM 'succeeded' THEN
      RAISE EXCEPTION 'scheduled tenant job run requires a running parent'
        USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_tenant_run_parent_running';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
       OR current_user = pg_catalog.pg_get_userbyid(
         (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID)
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'scheduled tenant job evidence is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_tenant_run_delete_guard';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'scheduled tenant job run is already final'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_tenant_run_final_immutable';
  END IF;
  SELECT parent.aggregate_status
    INTO parent_aggregate_status
    FROM public.scheduled_job_runs AS parent
   WHERE parent.id = NEW.run_id;
  IF parent_aggregate_status IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'scheduled tenant job run requires a running parent'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_tenant_run_parent_running';
  END IF;
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'scheduled tenant job identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_job_tenant_run_identity_immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_scheduled_job_tenant_run_transition_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.scheduled_job_tenant_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.scheduled_job_tenant_run_transition_guard();

CREATE OR REPLACE FUNCTION public.prune_scheduled_job_run_evidence()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  WITH candidates AS (
    SELECT run.id
      FROM public.scheduled_job_runs AS run
     WHERE run.aggregate_status <> 'running'
       AND run.finished_at < clock_timestamp() - INTERVAL '400 days'
     ORDER BY run.finished_at, run.id
     LIMIT 1000
     FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM public.scheduled_job_runs AS run
     USING candidates
     WHERE run.id = candidates.id
    RETURNING run.id
  )
  SELECT COUNT(*)::integer INTO deleted_count FROM removed;
  RETURN deleted_count;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.scheduled_job_run_transition_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.scheduled_job_run_finalization_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.scheduled_job_tenant_run_transition_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.prune_scheduled_job_run_evidence() FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE FORMAT(
      'GRANT SELECT, INSERT, UPDATE ON public.scheduled_job_runs TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE DELETE, TRUNCATE ON public.scheduled_job_runs FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE public.scheduled_job_runs_id_seq TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT, UPDATE ON public.scheduled_job_tenant_runs TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE DELETE, TRUNCATE ON public.scheduled_job_tenant_runs FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.scheduled_job_run_transition_guard() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.scheduled_job_run_finalization_guard() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.scheduled_job_tenant_run_transition_guard() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.prune_scheduled_job_run_evidence() TO %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

-- scheduled_notifications previously referenced users by globally allocated id
-- only. Repair any historical tenant drift before enforcing the composite
-- tenant/user relationship.
ALTER TABLE public.users
  ADD CONSTRAINT ux_users_tenant_id_id UNIQUE (tenant_id, id);

UPDATE public.scheduled_notifications AS scheduled
   SET tenant_id = owner.tenant_id
  FROM public.users AS owner
 WHERE owner.id = scheduled.user_id
   AND scheduled.tenant_id IS DISTINCT FROM owner.tenant_id;

ALTER TABLE public.scheduled_notifications
  DROP CONSTRAINT scheduled_notifications_user_fk;

ALTER TABLE public.scheduled_notifications
  ADD CONSTRAINT scheduled_notifications_tenant_user_fk
  FOREIGN KEY (tenant_id, user_id)
  REFERENCES public.users (tenant_id, id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.scheduled_notifications
  VALIDATE CONSTRAINT scheduled_notifications_tenant_user_fk;

CREATE INDEX idx_scheduled_notifications_tenant_user_status
  ON public.scheduled_notifications (tenant_id, user_id, status);

COMMIT;
