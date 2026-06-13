-- 309_bcma_scan_timestamps.sql
--
-- WS4 B4.2 (EPIC B6) — BCMA server-side 2-scan enforcement: auditable
-- scan timestamps.
--
-- The bedside Barcode Medication Administration (BCMA) loop is a TWO-scan
-- gate: the nurse scans the patient wristband (the "right patient" scan) AND
-- the medication barcode (the "right drug" scan) before a dose is charted.
-- The server-side enforcement of that gate lives in
-- marFiveRightsService.administerWithScan (the patient + drug rights must both
-- pass, or an explicit override reason must be supplied). To make the gate
-- AUDITABLE — to record WHEN each of the two bedside scans actually happened,
-- not just that a scan occurred — this migration adds two timestamp columns to
-- medication_administrations:
--
--   1. patient_scanned_at   — when the patient-wristband scan was captured.
--   2. medication_scanned_at — when the medication-barcode scan was captured.
--
-- Both are written (NOW()) by the scan-first administer path; the no-scan
-- override path leaves them NULL (no scan occurred). An override therefore
-- leaves a complete, queryable audit trail: NULL scan timestamps + a populated
-- override_reason distinguish a documented no-scan administration from a real
-- two-scan administration.
--
-- Design notes:
--   * Nullable for back-compat: existing rows + the genuine no-scan override
--     path carry NULL. No backfill — a NULL means "this dose was not charted
--     via the two-scan path".
--   * Purely additive (ADD COLUMN IF NOT EXISTS) so re-running against a
--     populated DB is a fast no-op.
--   * No new tables, so no new RLS policy is required. medication_administrations
--     already carries tenant_id (NOT NULL, DEFAULT the single-tenant floor) and
--     a tenant_isolation policy under ENABLE + FORCE ROW LEVEL SECURITY
--     (migrations 239 / 304). The new columns inherit that row-level isolation
--     automatically. We re-affirm ENABLE + FORCE here so the guarantee stays
--     explicit in the migration record (mirrors the 306/308 pattern), but do
--     not touch the existing tenant_isolation policy.
--   * check:phi-tenant-id: no new PHI tables introduced; the modified table
--     already has tenant_id + RLS.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Auditable bedside-scan timestamps for the BCMA two-scan gate
-- ---------------------------------------------------------------------------
ALTER TABLE medication_administrations
  ADD COLUMN IF NOT EXISTS patient_scanned_at    TIMESTAMPTZ;
ALTER TABLE medication_administrations
  ADD COLUMN IF NOT EXISTS medication_scanned_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. Re-affirm RLS + FORCE on the modified table (idempotent; the
--    tenant_isolation policy from 239/304 is left intact — we only ensure the
--    table-level flags stay on so the new columns are provably isolated).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE medication_administrations ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE medication_administrations FORCE ROW LEVEL SECURITY';
END
$$;

-- ---------------------------------------------------------------------------
-- Audit stamp (idempotent, repo convention).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'BCMA_SCAN_TIMESTAMPS_APPLIED',
  'medication_administrations',
  'medication_administrations',
  jsonb_build_object(
    'migration', '309_bcma_scan_timestamps.sql',
    'roadmap', 'WS4 B4.2 / docs/EPIC_LEVEL_ROADMAP.md#B6',
    'reason', 'Auditable patient/medication scan timestamps for the BCMA server-side two-scan gate; additive over 239/304.',
    'new_columns', ARRAY['patient_scanned_at', 'medication_scanned_at']
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'BCMA_SCAN_TIMESTAMPS_APPLIED'
    AND resource = 'medication_administrations'
);

COMMIT;
