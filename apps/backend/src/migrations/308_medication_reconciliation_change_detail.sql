-- 308_medication_reconciliation_change_detail.sql
--
-- WS4 B4.3 (EPIC B6) — additive enhancements layered over migration 279,
-- which created medication_reconciliations + medication_reconciliation_items.
--
-- 279 already delivered the formal three-point med-rec workflow (admission /
-- transfer / discharge), per-drug continue/stop/change/new/hold decisions
-- with a required reason, the take-home list, RLS + FORCE, and the canonical
-- timeline/audit invariant. It is NOT re-created here.
--
-- The B4.3 acceptance criterion asks for an explicit per-drug decision with
-- *structured* dose / route / frequency CHANGE DETAIL (not just free text),
-- and the workspace brief requires a medication_safety_reviews row whenever a
-- change/stop carries a safety rationale. 279's items table only had a single
-- free-text `new_instructions` column and no link to a safety review, so this
-- migration adds:
--
--   1. changed_dose / changed_route / changed_frequency — the structured
--      "to" side of a `change` decision (the "from" side is the existing
--      dose/route/frequency on the same row, which snapshots the source).
--      Nullable; only populated for `change` decisions.
--
--   2. safety_review_id — FK to medication_safety_reviews, set when a
--      stop/change decision is recorded WITH a safety rationale so the
--      canonical medication_safety_reviews row and the reconciliation item
--      are linked. ON DELETE SET NULL — the safety review is the audit
--      spine and outlives an item delete.
--
-- Design notes:
--   * Purely additive (ADD COLUMN IF NOT EXISTS + idempotent index/FK
--     guards) so re-running against a populated DB is a fast no-op.
--   * No new tables, so no new RLS policy is required; medication_safety_reviews
--     already carries tenant_id + a tenant_isolation policy (migration 269 /
--     304). We re-affirm ENABLE + FORCE ROW LEVEL SECURITY on
--     medication_reconciliation_items so the guarantee stays explicit in the
--     migration record (mirrors the 306 pattern), but do not touch the
--     existing tenant_isolation policy created in 279.
--   * check:phi-tenant-id: no new PHI tables introduced; the modified table
--     already has tenant_id + RLS from 279.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Structured change detail on reconciliation items
-- ---------------------------------------------------------------------------
ALTER TABLE medication_reconciliation_items
  ADD COLUMN IF NOT EXISTS changed_dose      VARCHAR(120);
ALTER TABLE medication_reconciliation_items
  ADD COLUMN IF NOT EXISTS changed_route     VARCHAR(40);
ALTER TABLE medication_reconciliation_items
  ADD COLUMN IF NOT EXISTS changed_frequency VARCHAR(120);

-- ---------------------------------------------------------------------------
-- 2. Link a recorded medication safety review back to the item that triggered it
-- ---------------------------------------------------------------------------
ALTER TABLE medication_reconciliation_items
  ADD COLUMN IF NOT EXISTS safety_review_id  UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'medication_reconciliation_items'
       AND constraint_name = 'fk_medication_reconciliation_items_safety_review'
  ) THEN
    EXECUTE $f$
      ALTER TABLE medication_reconciliation_items
        ADD CONSTRAINT fk_medication_reconciliation_items_safety_review
        FOREIGN KEY (safety_review_id) REFERENCES medication_safety_reviews(id)
        ON UPDATE NO ACTION ON DELETE SET NULL
    $f$;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_medication_reconciliation_items_safety_review
  ON medication_reconciliation_items (safety_review_id)
  WHERE safety_review_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Re-affirm RLS + FORCE on the modified table (idempotent; policy from 279
--    is left intact — we only ensure the table-level flags stay on).
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
  'MEDICATION_RECONCILIATION_CHANGE_DETAIL_APPLIED',
  'medication_reconciliation_items',
  'medication_reconciliation_items',
  jsonb_build_object(
    'migration', '308_medication_reconciliation_change_detail.sql',
    'roadmap', 'WS4 B4.3 / docs/EPIC_LEVEL_ROADMAP.md#B6',
    'reason', 'Structured dose/route/frequency change detail + medication_safety_reviews link for per-drug change/stop decisions; additive over 279.',
    'new_columns', ARRAY['changed_dose', 'changed_route', 'changed_frequency', 'safety_review_id']
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'MEDICATION_RECONCILIATION_CHANGE_DETAIL_APPLIED'
    AND resource = 'medication_reconciliation_items'
);

COMMIT;
