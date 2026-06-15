-- 313_appeal_from_prior_auth.sql
--
-- Allow an appeal to originate from a denied prior-auth
-- (clinical_ai_prior_auth_requests) in addition to a denied billing claim
-- (insurance_claims). Exactly one source per appeal row.
--
-- Background: clinical_ai_appeal_letters was created (migration 040) with
-- claim_id INTEGER NOT NULL REFERENCES insurance_claims(id). The prior-auth
-- → appeal chain (feature: prior-auth-appeal-chain) requires appeals that
-- have NO billing claim yet — the denial happened at the pre-auth stage.
--
-- Changes:
--   1. Add prior_auth_id INTEGER (nullable FK → clinical_ai_prior_auth_requests).
--      ON DELETE CASCADE: deleting a prior-auth cleans up its orphaned appeal; consistent with claim_id's CASCADE.
--   2. Make claim_id nullable (existing rows are unaffected; all have claim_id
--      set, so no data migration is needed).
--   3. Add CHECK constraint chk_appeal_single_source: exactly one of
--      (claim_id, prior_auth_id) must be non-NULL per row.
--   4. Add partial unique index so each PA request maps to at most one appeal.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS, DROP/ADD CONSTRAINT via catalog
-- guard (matching migration 311 pattern), CREATE INDEX IF NOT EXISTS.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New nullable FK column for the prior-auth source.
-- ---------------------------------------------------------------------------
ALTER TABLE clinical_ai_appeal_letters
  ADD COLUMN IF NOT EXISTS prior_auth_id INTEGER
    REFERENCES clinical_ai_prior_auth_requests(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Make claim_id optional (existing rows all have claim_id set; safe).
-- ---------------------------------------------------------------------------
ALTER TABLE clinical_ai_appeal_letters
  ALTER COLUMN claim_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Exactly-one-source CHECK constraint.
--    ADD CONSTRAINT is not IF NOT EXISTS-aware; guard via the catalog
--    (mirrors migration 311 pattern).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_appeal_single_source'
      AND conrelid = 'clinical_ai_appeal_letters'::regclass
  ) THEN
    ALTER TABLE clinical_ai_appeal_letters
      DROP CONSTRAINT chk_appeal_single_source;
  END IF;

  ALTER TABLE clinical_ai_appeal_letters
    ADD CONSTRAINT chk_appeal_single_source CHECK (
      (claim_id IS NOT NULL AND prior_auth_id IS NULL)
      OR (claim_id IS NULL AND prior_auth_id IS NOT NULL)
    );
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Partial unique index: one appeal per prior-auth request.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_appeal_prior_auth
  ON clinical_ai_appeal_letters (prior_auth_id)
  WHERE prior_auth_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Audit stamp (idempotent — repo convention; mirrors 277 / 307 / 311).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'APPEAL_FROM_PRIOR_AUTH_APPLIED',
  'clinical_ai_appeal_letters',
  'clinical_ai_appeal_letters',
  jsonb_build_object(
    'migration', '313_appeal_from_prior_auth.sql',
    'feature', 'prior-auth-appeal-chain',
    'reason', 'Allow appeal to originate from a denied prior-auth (clinical_ai_prior_auth_requests) in addition to a denied billing claim (insurance_claims). Exactly one source per appeal row enforced by chk_appeal_single_source.',
    'changes', jsonb_build_array(
      'ADD COLUMN prior_auth_id INTEGER REFERENCES clinical_ai_prior_auth_requests(id) ON DELETE CASCADE',
      'ALTER COLUMN claim_id DROP NOT NULL',
      'ADD CONSTRAINT chk_appeal_single_source CHECK (exactly one of claim_id / prior_auth_id non-NULL)',
      'CREATE UNIQUE INDEX uq_appeal_prior_auth ON (prior_auth_id) WHERE prior_auth_id IS NOT NULL'
    ),
    'decision_support_only', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'APPEAL_FROM_PRIOR_AUTH_APPLIED'
    AND resource = 'clinical_ai_appeal_letters'
);

COMMIT;
