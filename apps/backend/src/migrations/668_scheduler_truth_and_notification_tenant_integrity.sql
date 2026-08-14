-- Migration 668: truthful tenant fan-out receipts and scheduled-notification
-- tenant ownership.
--
-- @no-transaction
-- @statement_timeout: 0
--
-- Why @no-transaction (audit 2026-08-13, H-1). This file's last section anchors
-- a composite tenant/user FK, and the first draft did it by adding a
-- table-level UNIQUE constraint on users (tenant_id, id) via ALTER TABLE,
-- which builds a full btree over `users` — the hottest table in the system —
-- while holding ACCESS EXCLUSIVE on it. Inside the single PreSync transaction
-- that lock is held until COMMIT, so on a production-sized `users` the DDL
-- either exceeds the runner's statement_timeout (failing the PreSync Job, so
-- the ArgoCD sync aborts and the rollout CrashLoopBackOffs against the job's
-- backoffLimit) or stalls every query that touches `users` for the duration.
-- The same transaction also made the NOT VALID / VALIDATE split on
-- `scheduled_notifications` pointless: ADD CONSTRAINT ... NOT VALID takes
-- ACCESS EXCLUSIVE, and inside one transaction that lock is still held across
-- the subsequent VALIDATE, which is the exact outage NOT VALID exists to avoid.
--
-- So this file follows migration 598 (the other composite-tenant-FK migration)
-- and 647 (the other `users` index build): the runner applies each statement on
-- the session, CONCURRENTLY is legal, and each ALTER commits its brief lock
-- immediately instead of pinning it until the end of the file.
--
-- The anchor is a plain `CREATE UNIQUE INDEX CONCURRENTLY`, not
-- `ADD CONSTRAINT ... UNIQUE USING INDEX`. Postgres accepts any immediate,
-- valid unique index as an FK target — it does not require a pg_constraint row
-- — and every other composite anchor in this repo is spelled the same way
-- (598 `ux_facilities_tenant_id`, 580 `ux_users_tenant_uid_for_pathways`,
-- 605 `ux_users_tenant_id_id_uid_for_cc_replay`, 669 `ux_payslips_tenant_id`).
-- Promoting the index to a constraint would buy nothing and would re-acquire
-- ACCESS EXCLUSIVE on `users` for the catalog flip, which under load can pile
-- up behind one long-running query and block everything queued behind it.
-- `prisma db pull` renders a constraint-backed and a plain unique index
-- identically as `@@unique([tenant_id, id], map: "ux_users_tenant_id_id")`, so
-- schema.prisma is unchanged either way.
--
-- @statement_timeout: 0 exists for the CONCURRENTLY build, which is legitimately
-- unbounded on a large `users` (same reasoning as 647). Nothing else here is
-- unbounded: the one backfill chunks itself and commits per batch (see below).
--
-- RE-RUNNABILITY CONTRACT. @no-transaction gives up atomic rollback — a
-- mid-file failure leaves the file partially applied and UNRECORDED, so the
-- runner replays it from the top on the next boot. Every statement below is
-- therefore written to be a no-op on re-run (IF NOT EXISTS / DROP-then-CREATE /
-- guarded ALTER / CONCURRENTLY / naturally-converging backfill). Keep it that
-- way when editing this file.

-- A scheduler run is a fleet-level operational fact. Tenant-specific outcomes
-- live in the child table and are protected by forced, explicit-context RLS.
CREATE TABLE IF NOT EXISTS public.scheduled_job_runs (
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

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_label_started
  ON public.scheduled_job_runs (job_label, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_running_started
  ON public.scheduled_job_runs (started_at, id)
  WHERE aggregate_status = 'running';

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_finished_retention
  ON public.scheduled_job_runs (finished_at, id)
  WHERE aggregate_status <> 'running';

CREATE TABLE IF NOT EXISTS public.scheduled_job_tenant_runs (
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

CREATE INDEX IF NOT EXISTS idx_scheduled_job_tenant_runs_tenant_started
  ON public.scheduled_job_tenant_runs (tenant_id, started_at DESC);

ALTER TABLE public.scheduled_job_tenant_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_job_tenant_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.scheduled_job_tenant_runs;
CREATE POLICY tenant_isolation
  ON public.scheduled_job_tenant_runs
  FOR ALL
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

DROP POLICY IF EXISTS scheduled_job_tenant_runs_explicit_context
  ON public.scheduled_job_tenant_runs;
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

DROP TRIGGER IF EXISTS trg_scheduled_job_run_finalization_guard
  ON public.scheduled_job_runs;
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

DROP TRIGGER IF EXISTS trg_scheduled_job_run_transition_guard
  ON public.scheduled_job_runs;
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

DROP TRIGGER IF EXISTS trg_scheduled_job_tenant_run_transition_guard
  ON public.scheduled_job_tenant_runs;
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

-- ---------------------------------------------------------------------------
-- scheduled_notifications previously referenced users by globally allocated id
-- only. Anchor, guard, repair, then validate — in that order, so no step holds
-- a blocking lock on `users` or `scheduled_notifications` while it scans.
--
-- 1. (tenant_id, id) anchor on `users`, built CONCURRENTLY.
--
--    `users.id` is the primary key, so (tenant_id, id) is unique by
--    construction and this build cannot encounter a duplicate. It takes
--    SHARE UPDATE EXCLUSIVE — concurrent SELECT/INSERT/UPDATE/DELETE on
--    `users` all proceed — instead of the ACCESS EXCLUSIVE that
--    `ADD CONSTRAINT ... UNIQUE` would take for the whole build.
--
--    An interrupted concurrent build leaves an INVALID same-name index behind.
--    Because @no-transaction means this file can be replayed after a partial
--    failure, move only that unusable remnant aside and drop it concurrently
--    first, so a replay cannot mistake it for an enforced anchor and cannot
--    trip over the name. (Same remnant dance as migration 647.)
-- ---------------------------------------------------------------------------

DROP INDEX CONCURRENTLY IF EXISTS public.ux_users_tenant_id_id_invalid_rebuild;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('public.ux_users_tenant_id_id')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.ux_users_tenant_id_id
      RENAME TO ux_users_tenant_id_id_invalid_rebuild;
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.ux_users_tenant_id_id_invalid_rebuild;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_users_tenant_id_id
  ON public.users (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 2. Composite tenant-scoped FK, NOT VALID and guarded so replays skip it.
--
--    NOT VALID performs no scan, so its ACCESS EXCLUSIVE on
--    scheduled_notifications is catalog-only and — because @no-transaction
--    commits each statement — released immediately rather than being held for
--    the rest of the file. From this commit forward every NEW write is
--    tenant-checked, which is what makes the repair in step 3 safe to run
--    while the application is live.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.scheduled_notifications'::regclass
       AND conname = 'scheduled_notifications_tenant_user_fk'
  ) THEN
    ALTER TABLE public.scheduled_notifications
      ADD CONSTRAINT scheduled_notifications_tenant_user_fk
      FOREIGN KEY (tenant_id, user_id)
      REFERENCES public.users (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Repair historical tenant drift, in committed chunks.
--
--    A notification's owning tenant is not a judgement call: `users.tenant_id`
--    is authoritative for who the row's `user_id` belongs to, so this is a
--    deterministic repair rather than a reassignment (contrast 598, which
--    refuses to guess and reports instead). On a healthy database it matches
--    zero rows.
--
--    It is chunked with a COMMIT per batch because @no-transaction runs each
--    statement in autocommit, which makes COMMIT inside a DO block legal, and
--    because @statement_timeout: 0 removes the backstop an unbounded single
--    UPDATE would otherwise have had. Each batch takes ROW EXCLUSIVE plus row
--    locks on at most 5,000 rows and releases them at once; readers and writers
--    of other rows are never blocked.
--
--    The loop converges strictly: every updated row is set to its owner's
--    tenant_id and therefore stops matching the IS DISTINCT FROM predicate, so
--    the batch count reaches zero. The iteration cap is a safety stop, not the
--    termination condition — if it ever trips, that is a bug worth failing on
--    rather than looping forever.
-- ---------------------------------------------------------------------------

DO $repair_scheduled_notification_tenants$
DECLARE
  batch_size CONSTANT integer := 5000;
  max_batches CONSTANT integer := 100000;
  batches integer := 0;
  moved integer;
  total bigint := 0;
BEGIN
  LOOP
    WITH drifted AS (
      SELECT scheduled.id
        FROM public.scheduled_notifications AS scheduled
        JOIN public.users AS owner ON owner.id = scheduled.user_id
       WHERE scheduled.tenant_id IS DISTINCT FROM owner.tenant_id
       ORDER BY scheduled.id
       LIMIT batch_size
       FOR UPDATE OF scheduled
    )
    UPDATE public.scheduled_notifications AS scheduled
       SET tenant_id = owner.tenant_id
      FROM drifted, public.users AS owner
     WHERE scheduled.id = drifted.id
       AND owner.id = scheduled.user_id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    EXIT WHEN moved = 0;

    total := total + moved;
    batches := batches + 1;
    IF batches > max_batches THEN
      RAISE EXCEPTION
        'migration 668: scheduled_notifications tenant repair did not converge after % batches (% rows moved)',
        max_batches, total;
    END IF;

    COMMIT;
  END LOOP;

  IF total > 0 THEN
    RAISE NOTICE
      'migration 668: repaired tenant ownership on % scheduled_notifications row(s)', total;
  END IF;
END
$repair_scheduled_notification_tenants$;

-- ---------------------------------------------------------------------------
-- 4. Validate. Takes SHARE UPDATE EXCLUSIVE on scheduled_notifications (and
--    ROW SHARE on users) — it scans without blocking reads or writes, which is
--    the whole point of having split it from step 2. Validating an
--    already-valid constraint is a no-op, so replays pass straight through.
-- ---------------------------------------------------------------------------

ALTER TABLE public.scheduled_notifications
  VALIDATE CONSTRAINT scheduled_notifications_tenant_user_fk;

-- ---------------------------------------------------------------------------
-- 5. Drop the superseded single-column FK, last — so a failure anywhere above
--    leaves the table still guarded by the original constraint.
-- ---------------------------------------------------------------------------

ALTER TABLE public.scheduled_notifications
  DROP CONSTRAINT IF EXISTS scheduled_notifications_user_fk;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scheduled_notifications_tenant_user_status
  ON public.scheduled_notifications (tenant_id, user_id, status);
