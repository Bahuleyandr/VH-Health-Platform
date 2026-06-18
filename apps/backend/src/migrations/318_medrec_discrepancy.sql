-- 318_medrec_discrepancy.sql
--
-- Clinical-safety fix (platform audit 2026-06-18 §C-2 med-rec) — additive over
-- migrations 279 (base med-rec tables) and 308 (structured change detail).
--
-- BACKGROUND
-- ----------
-- 279/308 gave us the three-point med-rec workflow with per-drug
-- continue/stop/change/new/hold decisions, but the reconciliation engine
-- deduped purely by raw lower-cased name and completion only checked that
-- *every item got a decision*. There was NO change/omission detection: a home
-- anticoagulant / insulin / antiepileptic that was simply never carried onto
-- the inpatient list (so it had no item, or an item nobody flagged) sailed
-- through and the reconciliation "completed". That is exactly the medication
-- error class med-rec exists to catch.
--
-- WHAT THIS ADDS
-- --------------
--   1. discrepancy_type on medication_reconciliation_items — the engine's
--      ingredient-level alignment verdict for the drug on that row:
--        added        — present on the inpatient/active side, not on the home list
--        omitted      — on the home list, dropped from the inpatient/active side
--        dose_changed — same ingredient on both sides, dose/route/frequency differ
--        duplicate    — same ingredient already represented by another kept item
--        unchanged    — same ingredient, same regimen on both sides
--      Nullable: rows created before this migration (and any row the engine has
--      not classified yet) read NULL, which the service treats as "not yet
--      classified", never as "clean".
--
-- DESIGN NOTES
--   * Purely additive (ADD COLUMN IF NOT EXISTS + an idempotent CHECK guard)
--     so re-running against a populated DB is a fast, safe no-op. No data
--     backfill — historical completed recs keep NULL.
--   * No new tables, so no new RLS policy is required. We re-affirm ENABLE +
--     FORCE ROW LEVEL SECURITY on the modified table (mirrors the 308 pattern)
--     so the guarantee stays explicit in the migration record; the
--     tenant_isolation policy created in 279 is left intact.
--   * check:phi-tenant-id: no new PHI tables introduced; the modified table
--     already carries tenant_id + RLS from 279.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-item ingredient-alignment verdict
-- ---------------------------------------------------------------------------
ALTER TABLE medication_reconciliation_items
  ADD COLUMN IF NOT EXISTS discrepancy_type VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'medication_reconciliation_items'
       AND constraint_name = 'chk_medication_reconciliation_items_discrepancy'
  ) THEN
    EXECUTE $f$
      ALTER TABLE medication_reconciliation_items
        ADD CONSTRAINT chk_medication_reconciliation_items_discrepancy
        CHECK (discrepancy_type IS NULL OR discrepancy_type IN
          ('added', 'omitted', 'dose_changed', 'duplicate', 'unchanged'))
    $f$;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_medication_reconciliation_items_discrepancy
  ON medication_reconciliation_items (reconciliation_id, discrepancy_type)
  WHERE discrepancy_type IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Re-affirm RLS + FORCE on the modified table (idempotent; the policy from
--    279 is left intact — we only ensure the table-level flags stay on).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE medication_reconciliation_items ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE medication_reconciliation_items FORCE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'medication_reconciliation_items'
       AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE $f$
      CREATE POLICY tenant_isolation ON medication_reconciliation_items
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
    $f$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Audit stamp (idempotent, repo convention).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'MEDICATION_RECONCILIATION_DISCREPANCY_APPLIED',
  'medication_reconciliation_items',
  'medication_reconciliation_items',
  jsonb_build_object(
    'migration', '318_medrec_discrepancy.sql',
    'audit', 'docs/PLATFORM_AUDIT_2026-06-18.md#C-2',
    'reason', 'Add discrepancy_type for ingredient-level added/omitted/dose_changed/duplicate/unchanged classification so omitted high-alert home meds block completion; additive over 279/308.',
    'new_columns', ARRAY['discrepancy_type']
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'MEDICATION_RECONCILIATION_DISCREPANCY_APPLIED'
    AND resource = 'medication_reconciliation_items'
);

COMMIT;
