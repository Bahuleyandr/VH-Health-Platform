-- 278_bcma_closed_loop.sql
--
-- Roadmap Pillar B / item B1 (docs/EPIC_LEVEL_ROADMAP.md) — close the
-- medication loop. Two server-side gaps remain around the existing
-- 5-rights scan engine (marFiveRightsService):
--
--   1. The pharmacy lifecycle (PENDING→CONFIRMED→PREPARING→…) has no
--      pharmacist CLINICAL VERIFICATION step — nothing forces a pharmacist
--      to review the order against allergies/interactions before
--      PREPARING/dispensing. This migration adds the verification axis as
--      ORTHOGONAL COLUMNS on pharmacy_orders rather than a new lifecycle
--      status, so the three clients' status enums stay untouched while the
--      backend hard-gates PREPARING / DISPATCH / DISPENSE on it.
--   2. Drug-right scanning matches free-text medication names. Dispensed
--      med packs get a platform-issued pack_barcode that the MAR drug
--      scan can match exactly.
--
-- Grandfathering: orders already past the gate (PREPARING and beyond, or
-- terminal) are stamped 'verified' with a migration marker so historical
-- rows do not read as unverified dispenses in reports. In-flight
-- PENDING/CONFIRMED orders start 'pending' — they go through the new gate,
-- which is the intent of the feature.

BEGIN;

ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS clinical_verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS clinically_verified_by UUID,
  ADD COLUMN IF NOT EXISTS clinically_verified_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS clinical_verification_notes TEXT,
  ADD COLUMN IF NOT EXISTS clinical_verification_findings JSONB,
  ADD COLUMN IF NOT EXISTS pack_barcode VARCHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_pharmacy_orders_clinical_verification'
  ) THEN
    ALTER TABLE pharmacy_orders
      ADD CONSTRAINT chk_pharmacy_orders_clinical_verification
      CHECK (clinical_verification_status IN ('pending', 'verified', 'override', 'rejected'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pharmacy_orders_pack_barcode
  ON pharmacy_orders (pack_barcode) WHERE pack_barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pharmacy_orders_verification_pending
  ON pharmacy_orders (clinical_verification_status, created_at DESC)
  WHERE clinical_verification_status = 'pending';

-- Grandfather rows already past the new gate.
UPDATE pharmacy_orders
   SET clinical_verification_status = 'verified',
       clinical_verification_notes = 'Grandfathered by migration 278 (order predates the pharmacist clinical-verification gate)'
 WHERE clinical_verification_status = 'pending'
   AND status NOT IN ('PENDING', 'CONFIRMED');

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'BCMA_CLOSED_LOOP_APPLIED',
  'pharmacy_orders',
  'pharmacy_orders',
  jsonb_build_object(
    'migration', '278_bcma_closed_loop.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B1',
    'reason', 'Pharmacist clinical-verification gate columns + med-pack barcode on pharmacy_orders; PREPARING/DISPATCH/DISPENSE now require verification server-side.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'BCMA_CLOSED_LOOP_APPLIED'
    AND resource = 'pharmacy_orders'
);

COMMIT;
