-- Migration 194: backfill `ON DELETE SET NULL` on four FK constraints
-- whose source migrations created them without an explicit ON DELETE
-- clause (defaulting to NO ACTION).
--
-- The committed prisma/schema.prisma declares `onDelete: SetNull` on
-- these relations; this brings the DB into agreement and unblocks
-- `apps/backend/scripts/check-schema-drift.mjs` in CI.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS first, then ADD with the
-- desired behavior. Verified on Trenzalore dev DB (2026-05-12) — all
-- four FKs already have SET NULL via incremental ad-hoc drift, so
-- this is a no-op there. Fresh-rebuild DBs (CI's ci-setup-db flow)
-- lacked the constraint and now get it.
--
-- Affected relations:
--   * admissions.from_er_visit_id   → emergency_visits.id   (migration 170)
--   * insurance_claims.parent_claim_id → insurance_claims.id (self-FK; claim enhancement chain)
--   * advance_deposits.parent_deposit_id → advance_deposits.id (self-FK; refund chain)
--   * ward_indents.ward_id          → wards.id

BEGIN;

ALTER TABLE admissions
  DROP CONSTRAINT IF EXISTS admissions_from_er_visit_id_fkey;
ALTER TABLE admissions
  ADD CONSTRAINT admissions_from_er_visit_id_fkey
  FOREIGN KEY (from_er_visit_id) REFERENCES emergency_visits(id) ON DELETE SET NULL;

ALTER TABLE insurance_claims
  DROP CONSTRAINT IF EXISTS insurance_claims_parent_claim_id_fkey;
ALTER TABLE insurance_claims
  ADD CONSTRAINT insurance_claims_parent_claim_id_fkey
  FOREIGN KEY (parent_claim_id) REFERENCES insurance_claims(id) ON DELETE SET NULL;

ALTER TABLE advance_deposits
  DROP CONSTRAINT IF EXISTS advance_deposits_parent_deposit_id_fkey;
ALTER TABLE advance_deposits
  ADD CONSTRAINT advance_deposits_parent_deposit_id_fkey
  FOREIGN KEY (parent_deposit_id) REFERENCES advance_deposits(id) ON DELETE SET NULL;

ALTER TABLE ward_indents
  DROP CONSTRAINT IF EXISTS ward_indents_ward_id_fkey;
ALTER TABLE ward_indents
  ADD CONSTRAINT ward_indents_ward_id_fkey
  FOREIGN KEY (ward_id) REFERENCES wards(id) ON DELETE SET NULL;

COMMIT;
