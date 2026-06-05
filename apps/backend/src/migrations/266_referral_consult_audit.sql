-- 266_referral_consult_audit.sql
--
-- Ward cross-referrals need a first-seen timestamp so Admin/SuperAdmin can
-- audit request-to-review turnaround without mining generic PHI access logs.

ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_seen_by UUID,
  ADD COLUMN IF NOT EXISTS request_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'ward';

CREATE INDEX IF NOT EXISTS idx_referrals_tenant_status_department_created
  ON referrals(tenant_id, status, referred_to_department, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referrals_tenant_first_seen
  ON referrals(tenant_id, first_seen_at DESC)
  WHERE first_seen_at IS NOT NULL;
