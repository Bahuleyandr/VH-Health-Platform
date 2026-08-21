-- 675_release_staff_message_attachment_failed_backlog.sql
--
-- Reclassifies staff_message_attachments rows stuck at scan_status='failed'
-- to 'not_scanned' — the same treatment migration 674 gave the file_metadata
-- 'PENDING' backlog, extended to the attachment history 674 deliberately
-- deferred.
--
-- WHY THIS IS SAFE (the owner decision 674 asked for, made on the record)
-- ----------------------------------------------------------------------
-- Migration 674's header refused to touch these rows because 'failed' reads as
-- "a scan was attempted and its outcome is unknown" — a different epistemic
-- state from "no scan was attempted". On THIS deployment that distinction is
-- vacuous, and the population is not an edge case, it is effectively the
-- entire attachment history:
--
--   * No clamd daemon has ever been deployed anywhere in this platform
--     (nothing in infra/ ships one; src/utils/virusScanner.js probes
--     127.0.0.1:3310 and the prod ConfigMap documents the absence).
--   * The pre-#871 messaging writer stored 'failed' whenever that probe found
--     no daemon — its "scan attempt" was a TCP ping to a port nothing ever
--     listened on. These bytes are in exactly the same never-looked-at state
--     as the 'PENDING' rows 674 DID reclassify.
--   * A detected threat could never produce a 'failed' row: the old writer
--     refused infected files BEFORE storage ('quarantined' was never stored),
--     and the new writer (services/security/fileScanService.js) throws on
--     every non-clean outcome and never writes 'failed' at all. So every
--     'failed' row is a pre-policy legacy row, and none of them records a
--     positive malware finding.
--
-- Without this migration, rollout of the #871 allowlist gate silently 423s
-- every previously-downloadable staff-message attachment under BOTH policy
-- values ('failed' is never servable). After it, the history carries the
-- honest status: under disabled_accepted_risk (the declared prod posture)
-- these rows serve on the same terms as any new upload; under `required`
-- they stay blocked until actually scanned — exactly like 674's backlog.
--
-- DELIBERATELY NOT TOUCHED
-- ------------------------
--   * 'quarantined' — known-bad stays blocked forever, under every policy.
--   * 'pending'     — the old messaging writer always set a status explicitly,
--     so no such rows should exist; if one somehow does, it stays blocked and
--     visible in the admin quarantine review surface rather than being
--     released by a migration that cannot know its provenance.
--
-- LOCK DISCIPLINE (the 674-F4 lesson)
-- -----------------------------------
-- This file is a single UPDATE and carries NO DDL, so it takes ROW EXCLUSIVE
-- only — no ACCESS EXCLUSIVE lock, and concurrent reads are never blocked
-- (MVCC); concurrent writers block only on the touched rows for the duration
-- of the statement. The table holds one row per staff-message attachment of a
-- single-hospital deployment whose attachment feature launched 2026-06-03, so
-- the row count is small and the runner's default 120s statement timeout /
-- 300s transaction cap are ample headroom; no @statement_timeout directive and
-- no batching are needed. The scan_status predicate is exact — the new-code
-- writer never produces 'failed', so this cannot race a live ingest.

BEGIN;

UPDATE staff_message_attachments
   SET scan_status = 'not_scanned',
       updated_at  = NOW()
 WHERE scan_status = 'failed';

COMMIT;
