-- 653: ABHA verification gate (squat fix).
--
-- With ABDM disabled (the default deployment posture), registerABHA linked any
-- well-formed 14-digit number after a format check only, and migration 647's
-- tenant-scoped canonical unique index then made that unverified claim
-- permanent: the rightful ABHA holder was locked out with ABHA_ALREADY_LINKED
-- and no unlink path exists. The fix is a verification gate, not an unlink
-- route: a link now carries an explicit verification status, and only a
-- gateway-VERIFIED link owns the canonical unique slot or resolves in
-- ABDM flows (inbound callbacks, staff lookup).
--
-- Existing rows all become 'pending' deliberately: nothing in this deployment
-- was ever gateway-verified (verification only runs when ABDM_ENABLED, which
-- has never been on here). The number stays on the account and displays
-- exactly as before; it gets verified once ABDM is enabled and the patient
-- (or an admin) runs POST /abdm/my-abha/verify.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS abha_verification_status VARCHAR(16) NOT NULL DEFAULT 'pending';

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_abha_verification_status;
ALTER TABLE users
  ADD CONSTRAINT chk_users_abha_verification_status
  CHECK (abha_verification_status IN ('pending', 'verified'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS abha_verified_at TIMESTAMPTZ NULL;

-- Re-scope 647's canonical uniqueness to VERIFIED links only. A pending claim
-- must not consume the unique slot — otherwise a squatter's unverified claim
-- still blocks the rightful owner at the DB level and the gate is cosmetic.
-- Two patients may hold the same number as pending claims; the first to verify
-- wins the slot and the loser's verify attempt maps to 409 ABHA_ALREADY_LINKED.
--
-- No duplicate preflight (contrast 647): 647's index guaranteed no duplicate
-- canonical number per tenant exists, and this migration moves every row to
-- 'pending', so the reshaped (verified-only) index starts over an empty set —
-- there is nothing to reconcile.
DROP INDEX IF EXISTS uniq_users_tenant_abha_number_canonical;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_tenant_abha_number_canonical
  ON users (tenant_id, (regexp_replace(abha_number, '-', '', 'g')))
  WHERE abha_number IS NOT NULL
    AND btrim(abha_number) <> ''
    AND abha_verification_status = 'verified';
