-- 197_insurance_claim_caps_tpa_support.sql
--
-- Wrong-table-tpa batch 4 — extend `insurance_claim_caps` so caps can be
-- set against `tpa_claims` rows as well as the legacy `insurance_claims`.
--
-- Background: migration 178 introduced `insurance_claim_caps` with an
-- FK to `insurance_claims(id)`. Sprint 5 (migration 153) split the TPA
-- cashless/reimbursement workflow off into a separate `tpa_claims`
-- table — the table that today's `/api/v1/insurance/claims` surface
-- (claimsService) actually writes to. Result: every cap POSTed by the
-- biller against a live TPA claim id returns 404 because the caps
-- service looks the id up in `insurance_claims`. See finding
-- 2026-05-09-tpa-insurance-claim-billing-caps-table-split.
--
-- We keep one caps table — partial unique indexes give us a clean
-- (claim, category) uniqueness on each side without a discriminator
-- column. A CHECK constraint enforces that exactly one of
-- `claim_id`/`tpa_claim_id` is set on every row.
--
-- The legacy `claim_id` path remains intact (existing rows untouched,
-- partial unique on `(claim_id, category) WHERE claim_id IS NOT NULL`
-- preserves the prior uniqueness invariant). Clinical-AI back-refs
-- still reach `insurance_claims` via `claim_id` only — they have no
-- TPA equivalent and don't need one.

BEGIN;

-- 1) Relax NOT NULL on claim_id — required so a row can carry just
-- tpa_claim_id instead. The CHECK constraint below preserves the
-- "exactly one parent" invariant.
ALTER TABLE insurance_claim_caps
  ALTER COLUMN claim_id DROP NOT NULL;

-- 2) New nullable FK to tpa_claims. CASCADE delete mirrors the legacy
-- side so caps clean up when the parent claim is removed.
ALTER TABLE insurance_claim_caps
  ADD COLUMN IF NOT EXISTS tpa_claim_id INTEGER
    REFERENCES tpa_claims(id) ON DELETE CASCADE;

-- 3) Exactly-one-parent CHECK. Named so the service layer can surface
-- a meaningful error if it's ever violated.
ALTER TABLE insurance_claim_caps
  DROP CONSTRAINT IF EXISTS insurance_claim_caps_exactly_one_parent;
ALTER TABLE insurance_claim_caps
  ADD CONSTRAINT insurance_claim_caps_exactly_one_parent
  CHECK ((claim_id IS NOT NULL) <> (tpa_claim_id IS NOT NULL));

-- 4) Replace the single full UNIQUE(claim_id, category) with two
-- partial unique indexes — one per parent side. Postgres auto-names
-- the original constraint `<table>_<col1>_<col2>_key`.
ALTER TABLE insurance_claim_caps
  DROP CONSTRAINT IF EXISTS insurance_claim_caps_claim_id_category_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_insurance_claim_caps_claim_category
  ON insurance_claim_caps (claim_id, category)
  WHERE claim_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_insurance_claim_caps_tpa_claim_category
  ON insurance_claim_caps (tpa_claim_id, category)
  WHERE tpa_claim_id IS NOT NULL;

-- 5) Lookup index for tpa_claim_id, mirroring the legacy idx on claim_id.
CREATE INDEX IF NOT EXISTS idx_insurance_claim_caps_tpa_claim
  ON insurance_claim_caps (tpa_claim_id)
  WHERE tpa_claim_id IS NOT NULL;

COMMIT;
