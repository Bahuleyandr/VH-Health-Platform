-- Migration 804: let the retention prune use the index that was built for it.
--
-- WHAT CHANGES: one token in the body of
-- public.prune_scheduled_job_run_evidence(), defined in migration
-- 668_scheduler_truth_and_notification_tenant_integrity.sql.
--
--   before:  AND run.finished_at < clock_timestamp() - INTERVAL '400 days'
--   after:   AND run.finished_at < statement_timestamp() - INTERVAL '400 days'
--
-- Nothing else differs. The body below was produced from 668's by replacing
-- that single call; the two are byte-identical otherwise, and
-- src/tests/unit/pruneRetentionIndexCond.test.js asserts exactly that, so a
-- later edit cannot quietly widen this migration.
--
-- WHY. `clock_timestamp()` is VOLATILE — the only volatile member of its family
-- (`now()`, `statement_timestamp()` and `transaction_timestamp()` are STABLE).
-- Postgres cannot use a volatile expression as an index scan boundary, so the
-- partial index built for this exact query,
--
--   idx_scheduled_job_runs_finished_retention (finished_at, id)
--     WHERE aggregate_status <> 'running'
--
-- supplied only the ORDERING while the cutoff degraded to a per-row Filter.
-- Every call therefore examined every finished run.
--
-- Measured on the dalekdefender rig 2026-09-09: scheduled_job_runs holds
-- 300,929 rows, 298,117 of them finished; min(finished_at) is 2026-08-21 and
-- the count of rows older than 400 days is ZERO. So every scheduled job, on
-- every cron boundary, scanned ~298k rows under a volatile filter in order to
-- delete nothing — and would keep doing so until the deployment is 400 days
-- old. That scan is what pushed `Slow Prisma[primary] query` to 1.3-2.0 s and,
-- with ~45 jobs on a `*/10` boundary sharing one connection pool, what starved
-- the readiness probe (`GET /` runs a real SELECT 1 on that pool).
--
-- Local reproduction on an isolated fixture, same DDL, nothing prunable:
--   plan before : Index Only Scan, Filter, Rows Removed by Filter = every row,
--                 143,008 buffers, 113.088 ms at 200k rows
--   plan after  : Bitmap Index Scan, Index Cond, 9 buffers, 0.077 ms
--   cost curve  : before 28-60 ms @50k, ~100 ms @200k, ~210 ms @400k,
--                 421-687 ms @800k, 1245-1331 ms @2.4M — i.e. O(rows)
--                 after  flat 5-16 ms across that whole range
--
-- WHAT DOES NOT CHANGE: the set of rows deleted. `statement_timestamp()` is the
-- start of the current statement; `clock_timestamp()` is the instant it is
-- called. Against a 400-day cutoff the two differ by the duration of one
-- statement, which cannot move a row across the boundary in any realistic
-- deployment. The retention window, the LIMIT, the FOR UPDATE SKIP LOCKED and
-- the return value are untouched.
--
-- WHY NOT ALSO CHANGE THE CADENCE. The prune runs once per fan-out job
-- (utils/tenantFanout.js createRun), so ~30 fire together at a `*/5` boundary,
-- and calling it once per tick instead was the obvious alternative. It was
-- measured and declined: see the PR body. Once the cutoff is an Index Cond the
-- redundancy costs about 3 ms per boundary, which does not justify the
-- machinery or the review surface.
--
-- PRIVILEGES. `CREATE OR REPLACE FUNCTION` preserves the existing owner and
-- ACL, so 668's `REVOKE ALL ... FROM PUBLIC` and its runtime-role GRANT still
-- stand and are deliberately not repeated here. This matters because the
-- function is SECURITY DEFINER: it executes as its owner, and replacing it
-- requires being that owner. If a future migration runner applies this as a
-- different role, Postgres refuses the replace — the migration fails closed
-- rather than silently re-owning a SECURITY DEFINER function.
--
-- NOTE FOR REVIEWERS. Nothing in CI validates a plpgsql body after the
-- baseline, so a syntax slip here reaches the database. The body is byte-
-- identical to the one already running on the rig apart from the single token
-- named above, and the unit test pins that; the deep test proves the resulting
-- plan uses an Index Cond rather than a Filter, because "it is faster" is not
-- the property being fixed.

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
       AND run.finished_at < statement_timestamp() - INTERVAL '400 days'
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
