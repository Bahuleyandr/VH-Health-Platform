-- 691_file_scan_status_drop_transitional_defaults.sql
--
-- The CONTRACT half of migration 676's expand/contract pair (676:47-55).
-- 676 added investigation_files.scan_status and consent_signatures.scan_status
-- as NOT NULL with a TRANSITIONAL DEFAULT 'not_scanned' so the previous
-- image's writers (whose Prisma client predates the column) survived the
-- rolling deploy. The #874 image is fully rolled: every writer stamps the
-- screener's verdict explicitly
--   (services/investigation/fileService.js INSERT, routes/consentRoutes.js INSERT),
-- so the defaults are dropped and the declared posture is restored: the only
-- path to a stored status is an explicit write. A writer that forgets the
-- column now fails loudly at INSERT time (23502) instead of being silently
-- defaulted.
--
-- Catalog-only ALTERs (no scan, no rewrite); ACCESS EXCLUSIVE held only for
-- the statement tail — same lock posture as 676's own closing block.
-- investigation_bookings' two per-file columns are deliberately untouched:
-- they are nullable and were never given a default (676:130-154).

BEGIN;

ALTER TABLE investigation_files
  ALTER COLUMN scan_status DROP DEFAULT;

ALTER TABLE consent_signatures
  ALTER COLUMN scan_status DROP DEFAULT;

COMMIT;
