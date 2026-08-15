-- 674_file_scan_policy_not_scanned_status.sql
--
-- Adds the `not_scanned` scan status to the attachment CHECK constraint, and
-- reclassifies the generic-upload backlog that the old code could never resolve.
--
-- BACKGROUND
-- ----------
-- No malware scanner is deployed on this cluster: nothing in infra/ ships a
-- clamd daemon, and src/utils/virusScanner.js probes 127.0.0.1:3310. The two
-- consumers of that scanner disagreed about what an unscannable file means, so
-- one missing daemon produced two opposite defects:
--
--   * controllers/upload/uploadController.js never called the scanner at all.
--     It stamped file_metadata.scan_status='PENDING' on every upload and no
--     worker ever advanced it, while its download gate refused anything that
--     was not 'clean'. Every file the API accepted with a 201 became
--     permanently un-retrievable (423) — including clinician-uploaded
--     investigation slips. The same stuck 'PENDING' also made
--     services/tenant/brandKitSchema.js reject every brand asset.
--
--   * services/messaging/messagingService.js did scan, recorded 'failed' when
--     the scanner was unreachable, and then gated downloads on
--     `scan_status = 'quarantined'` only — so 'failed' (i.e. never actually
--     scanned) attachments were served like clean ones.
--
-- src/config/fileScanPolicy.js now makes scanner availability a declared
-- deployment decision (FILE_SCAN_POLICY), with `not_scanned` as the honest
-- status for "no scan was attempted, by policy" — distinct from 'clean'
-- (proven good) and from 'failed' (attempted, outcome unknown).
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Widens chk_staff_msg_attachments_scan (migration 262) so attachments can
--    carry 'not_scanned'. The other four values are unchanged.
--
-- 2. Reclassifies the stuck file_metadata backlog 'PENDING' -> 'not_scanned'.
--    This is a statement of fact, not a grant of trust: uploadController was
--    the ONLY writer of file_metadata in the entire tree, and it never invoked
--    a scanner, so every one of those rows is literally a file nobody looked
--    at. Under FILE_SCAN_POLICY=required these rows stay blocked exactly as
--    they are today; under FILE_SCAN_POLICY=disabled_accepted_risk they become
--    retrievable on the same declared terms as any new upload, which is what
--    un-blackholes the existing backlog.
--
-- DELIBERATELY NOT DONE
-- ---------------------
-- staff_message_attachments rows sitting at 'failed' are NOT reclassified.
-- 'failed' records that a scan was attempted and its outcome is unknown; that
-- is a different fact from "no scan was attempted", it remains reachable under
-- a `required` policy with a flaky scanner, and collapsing the two would
-- destroy the distinction this whole change exists to create. Those rows stay
-- un-servable (they were being served before, which was the vulnerability).
-- Releasing them is an owner decision, not a migration.

BEGIN;

ALTER TABLE staff_message_attachments
  DROP CONSTRAINT IF EXISTS chk_staff_msg_attachments_scan;

ALTER TABLE staff_message_attachments
  ADD CONSTRAINT chk_staff_msg_attachments_scan
  CHECK (scan_status IN ('pending', 'clean', 'quarantined', 'failed', 'not_scanned'));

-- Case-insensitive: the controller wrote the uppercase literal 'PENDING', and
-- the column carries no CHECK, so both spellings may exist.
UPDATE file_metadata
   SET scan_status = 'not_scanned',
       updated_at  = NOW()
 WHERE LOWER(TRIM(COALESCE(scan_status, ''))) IN ('pending', '');

COMMIT;
