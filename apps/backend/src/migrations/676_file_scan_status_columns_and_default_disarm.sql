-- 676_file_scan_status_columns_and_default_disarm.sql
--
-- Two related repairs to the unified FILE_SCAN_POLICY layer (migration 674,
-- src/config/fileScanPolicy.js):
--
-- 1. SCAN-STATUS COLUMNS FOR THE SERVING GATES #871 LEFT UNGATED.
--    investigation_files, consent_signatures, and the two photo keys on
--    investigation_bookings (slip_photo_key / result_file_key) store caller
--    bytes and are served back to other users, but carried no scan_status at
--    all — so no gate could exist. Each gains a column using EXACTLY the 674
--    vocabulary and CHECK shape. Existing rows are backfilled 'not_scanned'
--    on the same justification as 674's PENDING reclassification: none of
--    these paths ever invoked a scanner, so every existing row is literally a
--    file nobody looked at. Under FILE_SCAN_POLICY=required they are blocked;
--    under disabled_accepted_risk they serve on the declared terms.
--
-- 2. DISARM THE 'PENDING' DEFAULTS (871-F5).
--    file_metadata.scan_status DEFAULT 'PENDING' and
--    staff_message_attachments.scan_status DEFAULT 'pending' meant any future
--    INSERT that omitted the column silently minted a permanently-423 row —
--    the precise blackhole #871 exists to eliminate. Every live writer sets
--    the status explicitly (from services/security/fileScanService.js), so
--    the defaults are dropped and file_metadata.scan_status becomes NOT NULL:
--    a writer that forgets the column now fails loudly at INSERT time instead
--    of silently storing bytes no gate will ever release. The new columns
--    added here likewise carry NO default — the only path to a stored status
--    is an explicit write of the screener's verdict.
--    (staff_message_attachments.scan_status is already NOT NULL; the GDPR
--    erasure writer touches file_metadata only via UPDATE and never inserts,
--    so NOT NULL cannot break it.)
--
-- LOCK DISCIPLINE (the 674-F4 lesson)
-- -----------------------------------
-- The runner applies this file as ONE transaction, and a transaction holds
-- every lock it acquires until COMMIT — statement order cannot release a lock
-- early, but it decides WHEN each lock's hold window starts. So:
--
--   * The one potentially-slow statement — the file_metadata backfill, a
--     sequential scan of "every file the API accepted" that should match ~0
--     rows after 674 — runs FIRST, before any ACCESS EXCLUSIVE lock exists
--     anywhere. Row locks only; concurrent reads are never blocked (MVCC).
--   * The three new-column tables are then handled one table at a time
--     (ADD COLUMN → backfill → SET NOT NULL/CHECK), so each table's AX window
--     opens as late as possible and its span covers only that table's own
--     small scan. These tables are small: per-investigation uploads, consent
--     signatures, and bookings of a single-hospital deployment.
--   * The catalog-only file_metadata / staff_message_attachments ALTERs run
--     LAST, so their AX windows are just the tail of the transaction
--     (DROP DEFAULT is catalog-only; SET NOT NULL is one validation scan).
--
-- The runner sets lock_timeout=15s, so a queued AX lock fails loudly rather
-- than stalling live pods; default 120s statement timeout / 300s transaction
-- cap are ample for these sizes, so no @statement_timeout directive is used.

BEGIN;

-- ── Slowest scan first, before any ACCESS EXCLUSIVE exists ──────────────────
-- Idempotent re-run of 674's reclassification predicate: any pending/blank/
-- NULL row that appeared since 674 can only have been minted by the DEFAULT
-- being dropped below (no writer stamps those values), i.e. it is the same
-- never-looked-at state 674 reclassified. Also a precondition for SET NOT NULL.
UPDATE file_metadata
   SET scan_status = 'not_scanned',
       updated_at  = NOW()
 WHERE LOWER(TRIM(COALESCE(scan_status, ''))) IN ('pending', '');

-- ── investigation_files ─────────────────────────────────────────────────────

ALTER TABLE investigation_files
  ADD COLUMN IF NOT EXISTS scan_status VARCHAR(30);

UPDATE investigation_files
   SET scan_status = 'not_scanned'
 WHERE scan_status IS NULL;

ALTER TABLE investigation_files
  ALTER COLUMN scan_status SET NOT NULL;

ALTER TABLE investigation_files
  ADD CONSTRAINT chk_investigation_files_scan
  CHECK (scan_status IN ('pending', 'clean', 'quarantined', 'failed', 'not_scanned'));

-- ── consent_signatures ──────────────────────────────────────────────────────

ALTER TABLE consent_signatures
  ADD COLUMN IF NOT EXISTS scan_status VARCHAR(30);

UPDATE consent_signatures
   SET scan_status = 'not_scanned'
 WHERE scan_status IS NULL;

ALTER TABLE consent_signatures
  ALTER COLUMN scan_status SET NOT NULL;

ALTER TABLE consent_signatures
  ADD CONSTRAINT chk_consent_signatures_scan
  CHECK (scan_status IN ('pending', 'clean', 'quarantined', 'failed', 'not_scanned'));

-- ── investigation_bookings (two per-file status columns) ────────────────────
-- NULL means "no such file on this booking"; a non-null status must be vocabulary.

ALTER TABLE investigation_bookings
  ADD COLUMN IF NOT EXISTS slip_photo_scan_status VARCHAR(30);

ALTER TABLE investigation_bookings
  ADD COLUMN IF NOT EXISTS result_file_scan_status VARCHAR(30);

UPDATE investigation_bookings
   SET slip_photo_scan_status = 'not_scanned'
 WHERE slip_photo_key IS NOT NULL
   AND slip_photo_scan_status IS NULL;

UPDATE investigation_bookings
   SET result_file_scan_status = 'not_scanned'
 WHERE result_file_key IS NOT NULL
   AND result_file_scan_status IS NULL;

ALTER TABLE investigation_bookings
  ADD CONSTRAINT chk_investigation_bookings_slip_scan
  CHECK (slip_photo_scan_status IS NULL
         OR slip_photo_scan_status IN ('pending', 'clean', 'quarantined', 'failed', 'not_scanned'));

ALTER TABLE investigation_bookings
  ADD CONSTRAINT chk_investigation_bookings_result_scan
  CHECK (result_file_scan_status IS NULL
         OR result_file_scan_status IN ('pending', 'clean', 'quarantined', 'failed', 'not_scanned'));

-- ── Catalog-only default disarm, last ───────────────────────────────────────

ALTER TABLE file_metadata
  ALTER COLUMN scan_status DROP DEFAULT;

ALTER TABLE file_metadata
  ALTER COLUMN scan_status SET NOT NULL;

ALTER TABLE staff_message_attachments
  ALTER COLUMN scan_status DROP DEFAULT;

COMMIT;
