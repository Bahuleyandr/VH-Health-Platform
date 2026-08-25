-- 730_ward_pharmacy_indent_notification_backlog_demotion.sql
--
-- @no-transaction
-- @statement_timeout: 600s
--
-- One-off backlog demotion for WARD_PHARMACY_INDENT notifications.
--
-- Re-audit lane J demoted this alert from HIGH to LOW at the dispatch site
-- (src/services/ipd/ipdSupportService.js:1119-1163,
-- notifyPharmacyStaffOfWardIndent). That change is FORWARD-ONLY: it decides
-- the priority of rows created after it deploys and does not touch rows
-- already stored in `notifications`. This file is the backward half.
--
-- ===========================================================================
-- WHAT AN OPERATOR SEES, BEFORE AND AFTER
-- ===========================================================================
--
-- BEFORE (every pre-existing WARD_PHARMACY_INDENT row, priority 'HIGH'):
--
--   1. Staff app. NotificationItem.isHighPriority
--      (apps/staff/lib/core/providers/notification_provider.dart:119-124) is
--      true when the priority is HIGH/CRITICAL *or* the type contains
--      CRITICAL / EMERGENCY / SOS. 'WARD_PHARMACY_INDENT' contains none of
--      those three, so on these rows the priority column is the ONLY thing
--      making them high. While HIGH they sit in the Safety Center feed, which
--      selects `isHighPriority || isInvestigationAlert`
--      (apps/staff/lib/features/safety/screens/safety_center_screen.dart:171;
--      isInvestigationAlert is false here too - it matches LAB /
--      INVESTIGATION / CRITICAL_VALUE / RADIOLOGY, provider lines 136-141),
--      and in the notifications screen's "critical" filter
--      (apps/staff/lib/features/notifications/screens/notifications_screen.dart:117).
--      There safetyEscalationLabel() (safety_center_screen.dart:41-48)
--      renders "Escalates in N min if unread" and then "Escalated until
--      acknowledged" - a state no pharmacist can clear by doing the work,
--      because no client calls the ward-indent lifecycle endpoints. Tapping
--      the row routes to /pharmacy (provider line 701), which has no
--      ward-indent list.
--
--   2. Server. notificationService.runUnreadCriticalEscalation
--      (src/services/notification/notificationService.js:747-837), driven by
--      the `*/10 * * * *` unread-critical-notification-escalation cron
--      (src/utils/scheduler.js:910-912), selects UNREAD rows older than
--      CRITICAL_NOTIFICATION_ESCALATION_MINUTES (default 15) that match
--      `UPPER(priority) IN ('HIGH','CRITICAL')` OR a type LIKE any of
--      '%CRITICAL%' / '%EMERGENCY%' / '%SOS%' / '%CODE_BLUE%' / '%LAB_ALERT%'
--      (notificationService.js:763-770). 'WARD_PHARMACY_INDENT' matches none
--      of those five patterns, so here too the priority column alone is what
--      puts the row in the candidate set. Every match writes a
--      notification_events 'auto_escalated' row and fans a HIGH
--      'CRITICAL_ALERT_ESCALATION' notification out to ADMIN / SUPER_ADMIN.
--      The NOT EXISTS guard (notificationService.js:772-777) makes that at
--      most once per notification, so the backlog is bounded rather than a
--      repeating page - but every not-yet-escalated row still costs one admin
--      page for an indent nobody can dispense.
--
-- AFTER this file runs (priority 'LOW'):
--
--   1. Staff app. isHighPriority is false, so the rows drop out of the Safety
--      Center feed and out of the notifications screen's "critical" filter.
--      They stay in the notification list under "all" / "unread" with the
--      title and body that were actually delivered (unchanged - see below).
--      Anywhere safetyEscalationLabel() still runs over one, an unread row
--      now reads "Monitor until acknowledged" and a read row "Acknowledged":
--      the escalation countdown is gone.
--   2. Server. runUnreadCriticalEscalation stops selecting them altogether -
--      'LOW' is not in ('HIGH','CRITICAL') and the type matches none of the
--      five LIKE patterns. No further 'auto_escalated' events and no further
--      ADMIN / SUPER_ADMIN pages for ward indents.
--   3. Escalations that ALREADY fired are not undone. Their
--      notification_events rows stay, with the HIGH priority they fired at
--      snapshotted in `notification_priority`, and the
--      'CRITICAL_ALERT_ESCALATION' notifications they produced stay in the
--      admin feeds at HIGH (the cron excludes that type from its own
--      candidate set, notificationService.js:771, so they never escalate
--      further). This file stops what has not happened yet; it does not erase
--      what has.
--
-- WHAT THIS MIGRATION CHANGES: `notifications.priority` (and `updated_at`),
-- for WARD_PHARMACY_INDENT rows that were dispatched while no dispensing
-- surface existed. Read and unread rows alike - the classification was wrong
-- for all of them, and a READ row left at HIGH stays inside the notifications
-- screen's "critical" filter permanently.
--
-- WHAT IT DELIBERATELY DOES NOT CHANGE:
--
--   * `title` / `body`. Those are the message that was actually delivered,
--     push included. Pre-existing rows therefore keep the old body, "Please
--     review the pharmacy ward indent for dispensing", which instructs a
--     screen that does not exist. Rewriting delivered message history is a
--     larger claim than this defect justifies; operators should expect the
--     old wording on any row that predates the fix.
--   * `data`. Rows predating the fix carry no `dispatch_surface_available`
--     key at all, so a client reading that key must treat "absent" as
--     unknown, not as false.
--   * `notification_events`. See point 3 above.
--
-- Rows dispatched WITH a working surface (data->>'dispatch_surface_available'
-- = 'true', i.e. written after an operator sets
-- PHARMACY_WARD_INDENT_PUSH_ENABLED=true in the release that ships the
-- dispensing screen) are excluded, so this file cannot silence a live
-- dispatch alert if it is ever replayed on a rebuilt database.
--
-- Cross-tenant by design: migrations run without `app.current_tenant_id` set,
-- and the canonical tenant_isolation policy installed by migration 304
-- (304_tenant_rls_policy_coverage.sql:263-275) passes when that setting is
-- unset, so this UPDATE reaches every tenant's rows. Verified rather than
-- assumed: on the scratch fixture described below, with `notifications` under
-- ENABLE + FORCE ROW LEVEL SECURITY carrying that policy and the file applied
-- by a NOSUPERUSER, non-BYPASSRLS owner role, the demoted rows spanned all
-- three tenant_ids in the fixture.
--
-- ===========================================================================
-- PLAN AND LOCK DISCIPLINE
-- ===========================================================================
--
-- WHERE THIS RUNS, AND WHAT A FAILURE COSTS. In production the file is applied
-- by the owner-credential ArgoCD PreSync Job
-- (infra/kubernetes/apps/backend/migration-job.yaml) through
-- scripts/ci-setup-db.mjs -> scripts/lib/ciMigrationExecutor.mjs; the
-- Deployment does not roll until that Job reports Complete, so a failure here
-- aborts the release. Production API workers never apply migrations - they
-- only verify that the tracker matches the image (src/bin/www.js:126-137) -
-- but everywhere else the same file runs in-process at boot through
-- src/utils/migrations/runMigrations.js, where a failure refuses to start.
-- Both appliers treat `-- @no-transaction` identically: one session,
-- `SET lock_timeout = '15s'` then `SET statement_timeout = '<directive>'`
-- (ciMigrationExecutor.mjs:50-51; applyNoTransactionMigration.js:161-162),
-- then the file's statements one at a time. Those are plain SET, not SET
-- LOCAL, so both settings survive the COMMITs inside the DO block below.
--
-- WHY THE PREDICATE IS AN EXACT MATCH. `type = 'WARD_PHARMACY_INDENT'` is
-- usable against notifications_type_idx (`CREATE INDEX notifications_type_idx
-- ON public.notifications USING btree (type)`, 000_baseline.sql:30736). The
-- `UPPER(COALESCE(type, ''))` an earlier draft used is not, so the planner had
-- no option but to read all of `notifications` - one of the largest tables in
-- the database - inside the deploy gate described above. Measured with
-- EXPLAIN (ANALYZE, BUFFERS) on a throwaway PostgreSQL 17.9 database holding
-- 404,068 `notifications` rows, VACUUM ANALYZEd, of which 4,065 carry type
-- 'WARD_PHARMACY_INDENT' and 4,000 of those are demotable:
--
--   UPPER(COALESCE(type,'')) = 'WARD_PHARMACY_INDENT'
--     -> Parallel Seq Scan. 9,648 buffers and 400,065 rows removed by filter
--        just to FIND the rows; 54,959 buffers and 303 ms for the whole
--        single-shot UPDATE of 4,000 rows.
--   type = 'WARD_PHARMACY_INDENT'
--     -> Bitmap Index Scan on notifications_type_idx. 6 index buffers + 131
--        heap blocks, and one 1,000-row batch of the form below in 12.8 ms.
--
-- Treat the heap-block half of those numbers as fixture-specific: it tracks
-- how tightly the matching rows happen to be clustered on disk, and the
-- fixture loaded them contiguously. The structural claim is the one that
-- carries, and it does not depend on the fixture: the exact predicate's cost
-- scales with the number of MATCHING rows, the UPPER() form's with the size of
-- `notifications`.
--
-- The exact-match predicate is also COMPLETE, not merely cheaper. These rows
-- have exactly one writer - notifyPharmacyStaffOfWardIndent, through
-- staffNotificationService.sendStaffNotifications - and that writer stores
-- `type` through normalizeType(), which upper-cases everything except the one
-- allow-listed lowercase event type 'lab_critical_alert'
-- (staffNotificationService.js:33-38), and `priority` through
-- normalizePriority(), which maps to exactly one of 'HIGH' / 'MEDIUM' / 'LOW'
-- (staffNotificationService.js:9-16, 40-43). Both columns are also NOT NULL
-- (000_baseline.sql:12827-12828), so the COALESCE wrappers the earlier draft
-- used were dead code on top of the index defeat. The cost of being wrong
-- about that is narrow and visible: a row whose type is not exactly
-- 'WARD_PHARMACY_INDENT' is simply left alone, not mis-updated.
--
-- EXPECTED ROW COUNT. Every matching row comes from one dispatch:
-- notifyPharmacyStaffOfWardIndent runs once per ward_indents row that
-- createWardIndentForClinicalMedicationOrder actually creates, fanned out to
-- the tenant's active PHARMACY_STAFF / PHARMACY_INCHARGE users (hard-capped
-- at MAX_RECIPIENTS = 500 per dispatch, staffNotificationService.js:8) and
-- deduped per (tenant_id, user_id, type, related_id) by the insert's
-- `dedupe: true` NOT EXISTS guard (staffNotificationService.js:226-233). So
--
--   matching rows <= (auto-created pharmacy ward indents)
--                    x (active pharmacy-role users in that tenant)
--
-- which on a single-hospital deployment is one inpatient-medication-order
-- count times a handful of pharmacists: thousands, not millions. This file
-- does not rely on that estimate - see the batching below - and it reports
-- what it actually changed. An operator can take the number beforehand with
--
--   SELECT count(*) FROM notifications
--    WHERE type = 'WARD_PHARMACY_INDENT'
--      AND priority <> 'LOW'
--      AND COALESCE(data ->> 'dispatch_surface_available', 'false') <> 'true';
--
-- LOCKING, IN BOTH DIRECTIONS. An earlier draft of this comment described only
-- the harmless one.
--
--   * Migration first. Once a batch has locked its rows, a concurrent writer
--     to one of them - in practice a staff mark-as-read - waits for that
--     batch's transaction, ~13 ms on the fixture above, and never for the
--     whole backfill, because each batch commits. That claim was true and
--     still is.
--
--   * Writer first. This is the direction that was missing, and it is the
--     dangerous one. A plain `FOR UPDATE` has to WAIT for whoever already
--     holds the row lock: the migration blocks, not the writer. And it does
--     not wait "one batch" - the session's `lock_timeout = '15s'`, set by both
--     appliers above, aborts the wait with SQLSTATE 55P03, `canceling
--     statement due to lock timeout`. That error propagates out of the DO
--     block, out of the file, and out of the PreSync Job, i.e. it aborts the
--     release. Measured on the fixture above with one uncommitted
--     `SELECT ... FOR UPDATE` held by a second session on a single row that
--     fell in batch 3: the migration blocked for 15.1 s and died 55P03 with
--     2,000 of its 4,000 rows committed and the file unrecorded.
--
-- `SKIP LOCKED` on the batch CTE removes the second direction: a row another
-- session already holds is passed over instead of waited for, so no batch can
-- block and this file cannot fail a deploy on row contention. The only lock
-- this statement can still wait on is the table-level ROW EXCLUSIVE, which
-- conflicts only with SHARE and above (i.e. DDL); nothing else in the run
-- holds that, because both appliers apply files one at a time on one session.
--
-- THE TRADE `SKIP LOCKED` MAKES, stated plainly. A successful run records the
-- file in `_migrations` and it never runs again. So a row that is locked at
-- the instant its batch is built, AND still locked on the pass that ends the
-- loop, is left at its old priority permanently. That window is small - a
-- skipped row stays in the predicate and is retried by every later pass, so
-- only skips on the final pass are lost, and a mark-as-read holds its row for
-- the length of one short UPDATE - but it is not zero, and this file does not
-- pretend otherwise: the DO block counts what it left behind and RAISEs a
-- WARNING naming the number. One leftover costs one row still in the Safety
-- Center feed and the "critical" filter for its recipient, plus at most one
-- ADMIN / SUPER_ADMIN escalation page (the cron's NOT EXISTS guard,
-- notificationService.js:772-777, fires at most once per notification). A
-- blocked deploy costs the whole release. The count query above finds any
-- leftovers, and this finishes them - it is the same predicate, unbatched,
-- and safe to run against a live database at these row counts:
--
--   UPDATE notifications SET priority = 'LOW', updated_at = NOW()
--    WHERE type = 'WARD_PHARMACY_INDENT'
--      AND priority <> 'LOW'
--      AND COALESCE(data ->> 'dispatch_surface_available', 'false') <> 'true';
--
-- HOW THE WORK IS BOUNDED. The UPDATE is batched at 1,000 rows per iteration,
-- each iteration its own transaction. That is why this file declares
-- `-- @no-transaction`: on the runner's default path the whole file is
-- wrapped in one transaction (runMigrations.js:183-188) and a COMMIT inside a
-- DO block is illegal there. Consequences:
--
--   * At most 1,000 row locks are held at any instant, for the ~13 ms a batch
--     took on the fixture above.
--   * This file contains no DDL, so it takes ROW EXCLUSIVE on `notifications`
--     and nothing stronger: no ACCESS EXCLUSIVE, and no reader is ever
--     blocked (MVCC).
--   * No long-lived transaction sits on the table holding vacuum back.
--   * The loop terminates, but NOT for the reason an earlier draft of this
--     comment gave. That draft argued nothing can re-enter the predicate
--     "after the dispatch-site fix" — which is false in the exact window this
--     file runs. infra/kubernetes/apps/backend/migration-job.yaml applies this
--     Job BEFORE the main sync and holds the Deployment until it reports
--     Complete, so while this loop runs the OLD image is still serving, and
--     the old notifyPharmacyStaffOfWardIndent still writes WARD_PHARMACY_INDENT
--     at HIGH with no dispatch_surface_available key — straight back into the
--     predicate. That writer is on a live request path (inpatient CPOE via
--     orderEntryService, and ER orders carried into an admission via
--     admissionService), not a cron.
--
--     Termination is therefore guaranteed by MAX_BATCHES below, not by the
--     predicate closing. Rows written during the rollout window stay HIGH and
--     are demoted by the next run of this backfill or acknowledged normally —
--     a bounded, visible residue rather than a loop that races a live writer.
--     The reported left_behind count makes that residue observable.
--
-- The statement-timeout directive at the top of this file is a RUNAWAY GUARD,
-- not a budget: at the measured ~13 ms per 1,000-row batch, 600s covers row
-- counts orders of magnitude beyond anything this dispatch path can produce.
-- What it actually bounds is the case where the index is somehow absent and
-- each batch degrades to a sequential scan, which would turn the loop
-- quadratic. Note that it bounds the WHOLE loop, not one batch: a COMMIT
-- inside a DO block does not re-arm statement_timeout (verified on the scratch
-- database - `SET statement_timeout = '2s'` plus a DO block sleeping 0.5s per
-- iteration and COMMITting died at 2s, not after ten iterations).
--
-- IF IT DOES TIME OUT (or the connection drops): batches already committed
-- stay committed, the file is NOT recorded in `_migrations`
-- (runMigrations.js:173-176 and ciMigrationExecutor.mjs:52-67 both record the
-- file only after every statement succeeds), and the next run resumes where it
-- stopped, because the predicate only ever matches rows that have not been
-- demoted yet. The same property makes an ordinary re-run a no-op: after the
-- first application the matching rows are already LOW. Verified on the scratch
-- database - a second apply changed nothing, `md5` of
-- (id, priority, updated_at) over every WARD_PHARMACY_INDENT row identical
-- before and after.
--
-- WHERE THE COUNTS SHOW UP. The DO block ends with RAISE LOG on a clean run
-- and RAISE WARNING when it left rows behind. Neither reaches the application
-- log: no applier installs a node-postgres `notice` handler (checked in
-- runMigrations.js, applyNoTransactionMigration.js and ci-setup-db.mjs), so
-- both are dropped by the client that ran the file. Both DO reach the Postgres
-- server log - the database pod's log, not the API pod's - because
-- log_min_messages defaults to 'warning' and LOG outranks WARNING for that
-- GUC. The WARNING additionally reaches an operator running this file by hand
-- in psql, since client_min_messages defaults to 'notice' and WARNING outranks
-- it; the LOG line does not. If the number is needed in the deploy log, run
-- the count query above before and after.

DO $migration_730$
DECLARE
  batch_size  CONSTANT integer := 1000;
  moved       integer;
  batches     integer := 0;
  -- Hard bound: the predicate can be re-entered by the old image while this
  -- Job runs (see HOW THE WORK IS BOUNDED), so the loop must not depend on it
  -- closing. 1,000 batches x 1,000 rows is ~1000x the largest plausible
  -- backlog on this dispatch path.
  max_batches constant integer := 1000;
  demoted     bigint  := 0;
  left_behind bigint;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
        FROM notifications
       WHERE type = 'WARD_PHARMACY_INDENT'
         AND priority <> 'LOW'
         AND COALESCE(data ->> 'dispatch_surface_available', 'false') <> 'true'
       LIMIT batch_size
         FOR UPDATE SKIP LOCKED
    )
    UPDATE notifications n
       SET priority   = 'LOW',
           updated_at = NOW()
      FROM batch b
     WHERE n.id = b.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    demoted := demoted + moved;
    IF moved > 0 THEN
      batches := batches + 1;
    END IF;

    COMMIT;
    EXIT WHEN moved = 0;
    EXIT WHEN batches >= max_batches;
  END LOOP;

  -- Anything still matching was locked by a concurrent writer on the pass that
  -- ended the loop, and SKIP LOCKED passed it over. A plain SELECT never waits
  -- on a row lock, so this cannot block; see THE TRADE above.
  SELECT count(*) INTO left_behind
    FROM notifications
   WHERE type = 'WARD_PHARMACY_INDENT'
     AND priority <> 'LOW'
     AND COALESCE(data ->> 'dispatch_surface_available', 'false') <> 'true';

  IF left_behind > 0 THEN
    RAISE WARNING 'migration 730: demoted % WARD_PHARMACY_INDENT notification row(s) to LOW in % batch(es) of up to %; % row(s) were locked by a concurrent writer and keep their old priority - finish them with the UPDATE in this file''s header',
      demoted, batches, batch_size, left_behind;
  ELSE
    RAISE LOG 'migration 730: demoted % WARD_PHARMACY_INDENT notification row(s) to LOW in % batch(es) of up to %; 0 left behind',
      demoted, batches, batch_size;
  END IF;
END
$migration_730$;
