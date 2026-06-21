-- Migration 323: float money columns -> numeric(12,2).
--
-- Audit 2026-06-18 §3 (Data layer, HIGH): two currency columns were stored as
-- `double precision` (IEEE-754 binary float):
--   * medications.price                  (pharmacy line-item unit price)
--   * investigation_template_tests.cost  (investigation/test charge)
-- Both flow into billing. Money in binary float does not round-trip exactly
-- (0.10 + 0.20 = 0.30000000000000004) and accumulated charges drift by
-- fractions of a paisa — unacceptable on a money path. This converts both to
-- numeric(12,2): exact decimal, 2-decimal (paise) scale, up to 10 integer
-- digits (max 99,999,999.99) which comfortably covers any single drug price or
-- test charge.
--
-- DESIGN NOTES (verified against the live QA schema before writing this
-- migration):
--
--  * BOTH columns are confirmed `double precision` and nullable. The cast
--    USING ROUND(col::numeric, 2) preserves every existing value, rounded to
--    paise. ROUND(numeric, 2) is half-away-from-zero (Postgres numeric rounding),
--    deterministic — unlike the float values it replaces. NULLs pass through
--    unchanged (ROUND(NULL) = NULL).
--
--  * SAFE-ON-EXISTING-DATA. The only way an ALTER ... TYPE numeric(12,2) cast can
--    fail is if an existing value exceeds the precision (|value| >= 10^10 after
--    rounding) — numeric overflow (22003). The DO-block below pre-checks both
--    columns for any such out-of-range value and RAISEs an actionable error
--    naming the table/column/id first, so the operator can correct the bad value
--    before applying, rather than hitting an opaque overflow mid-ALTER. Verified
--    no out-of-range values on the QA cluster before writing this migration.
--
--  * IDEMPOTENT. Each ALTER is guarded by an information_schema probe so a re-run
--    (or a DB where the column is already numeric) is a no-op — the ALTER only
--    fires while the column is still `double precision`.
--
--  * No CONCURRENTLY needed (ALTER TABLE is not an index build). The migration
--    runner wraps this file in one transaction; ALTER COLUMN TYPE takes the table
--    lock for a rewrite, which is acceptable for these two small reference tables.
--
--  * PRISMA. Both columns are Prisma-modelled (Medication.price,
--    InvestigationTemplateTest.cost), so prisma/schema.prisma is regenerated via
--    `prisma db pull` after this migration and the Float fields become Decimal.

BEGIN;

-- Pre-flight: refuse to apply if any existing value would overflow numeric(12,2).
DO $$
DECLARE
  bad RECORD;
BEGIN
  SELECT 'medications' AS tbl, 'price' AS col, id, price::text AS val
    INTO bad
    FROM medications
   WHERE price IS NOT NULL
     AND abs(price) >= 1e10
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'cannot convert %.% to numeric(12,2): row id % has out-of-range value %; correct it before applying migration 323',
      bad.tbl, bad.col, bad.id, bad.val;
  END IF;

  SELECT 'investigation_template_tests' AS tbl, 'cost' AS col, id, cost::text AS val
    INTO bad
    FROM investigation_template_tests
   WHERE cost IS NOT NULL
     AND abs(cost) >= 1e10
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'cannot convert %.% to numeric(12,2): row id % has out-of-range value %; correct it before applying migration 323',
      bad.tbl, bad.col, bad.id, bad.val;
  END IF;
END $$;

-- medications.price : double precision -> numeric(12,2) (value-preserving, rounded to paise)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'medications' AND column_name = 'price' AND data_type = 'double precision'
  ) THEN
    ALTER TABLE medications
      ALTER COLUMN price TYPE numeric(12,2) USING ROUND(price::numeric, 2);
  END IF;
END $$;

-- investigation_template_tests.cost : double precision -> numeric(12,2)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'investigation_template_tests' AND column_name = 'cost' AND data_type = 'double precision'
  ) THEN
    ALTER TABLE investigation_template_tests
      ALTER COLUMN cost TYPE numeric(12,2) USING ROUND(cost::numeric, 2);
  END IF;
END $$;

COMMIT;
