-- Migration 221 — tpa_claims.stage + parent_claim_id for claim hierarchy.
--
-- Ref: finding 2026-05-09-tpa-insurance-claim-discharge-final-claim-stage-dropped
--
-- Final claim API accepts `stage` and `parent_claim_id` in the request
-- body but the columns don't exist on tpa_claims, so they're silently
-- dropped. Without the link the TPA portal can't auto-correlate the
-- final claim with the originating preauth/enhancement and the auditor
-- can't reconstruct the full episode chain.
--
-- The chip hint about `insurance_preauth.parent_preauth_id` covers the
-- mid-stay enhancement hop; this migration adds the *claim*-level link
-- so a final claim row also knows its predecessor preauth-claim.
--
-- Adds:
--   * stage VARCHAR(20) - one of 'preauth', 'enhancement', 'final',
--     'reimbursement' (default 'final' for backward compat with
--     existing rows, since they're all final claims by construction).
--   * parent_claim_id INTEGER FK to tpa_claims(id) - the preceding
--     claim row in the episode chain (preauth-claim ← enhancement-
--     claim ← final-claim). NULL for the first/standalone claim.
--   * Index on parent_claim_id for parent-traversal queries.
--   * CHECK constraint on stage values.

BEGIN;

ALTER TABLE tpa_claims
  ADD COLUMN IF NOT EXISTS stage VARCHAR(20) DEFAULT 'final';

ALTER TABLE tpa_claims
  ADD COLUMN IF NOT EXISTS parent_claim_id INTEGER;

-- FK only added if it isn't already there. ADD CONSTRAINT IF NOT EXISTS
-- is not supported; use the catalog probe pattern matching existing
-- migrations 211/216.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tpa_claims_parent_claim_id_fkey'
       AND conrelid = 'public.tpa_claims'::regclass
  ) THEN
    ALTER TABLE tpa_claims
      ADD CONSTRAINT tpa_claims_parent_claim_id_fkey
        FOREIGN KEY (parent_claim_id) REFERENCES tpa_claims(id)
        ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tpa_claims_stage_check'
       AND conrelid = 'public.tpa_claims'::regclass
  ) THEN
    ALTER TABLE tpa_claims
      ADD CONSTRAINT tpa_claims_stage_check
        CHECK (stage IS NULL OR stage IN ('preauth', 'enhancement', 'final', 'reimbursement'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tpa_claims_parent_claim ON tpa_claims (parent_claim_id);

COMMIT;
