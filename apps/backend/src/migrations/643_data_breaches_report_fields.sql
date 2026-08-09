-- Migration 643: add title + phi_involved to data_breaches.
--
-- The admin Compliance "Report Breach" form (apps/admin BreachesTab.tsx) has
-- always collected a title and a PHI-involved flag, but the original table
-- (migration 126b) never had columns for either — both were silently
-- dropped on every report, and neither breachService.getBreaches nor
-- getBreachTimeline ever selected them (they didn't exist to select).
--
-- This is more than a decoration gap: BreachesTab's list-view filter reads
-- `b.title.toLowerCase()` unconditionally, and the row/detail views render
-- `breach.title` directly — so the moment breach reporting starts actually
-- persisting a row, the list view throws on the first one. Fixing the
-- report path without adding these columns would trade a silent write-loss
-- bug for a hard crash.
--
-- title is required by every read surface. Backfill existing rows from their
-- required description before applying NOT NULL so an older record cannot
-- make the compliance list crash when it calls title.toLowerCase().
-- phi_involved defaults to false so it is safe to add NOT NULL directly.

BEGIN;

ALTER TABLE data_breaches
  ADD COLUMN IF NOT EXISTS title VARCHAR(255),
  ADD COLUMN IF NOT EXISTS phi_involved BOOLEAN NOT NULL DEFAULT false;

UPDATE data_breaches
   SET title = LEFT(
     COALESCE(
       NULLIF(BTRIM(description), ''),
       'Reported data breach ' || COALESCE(breach_id, id::text)
     ),
     255
   )
 WHERE title IS NULL
    OR BTRIM(title) = '';

ALTER TABLE data_breaches
  ALTER COLUMN title SET NOT NULL;

COMMIT;
