-- Migration 101: hipaa_access_log + canary_checks + clinical_alerts.acknowledged_at.
--
-- Three small infrastructure misses that have been spamming the logs
-- since session start:
--
--   1. hipaa_access_log — every PHI-bearing endpoint runs a fire-and-
--      forget audit insert through hipaaAudit.js. The table never
--      existed; every insert was failing with 42P01 and falling through
--      to the Winston file fallback. Compliance gap: prod was not
--      keeping a structured DB record of who-accessed-what. (Same
--      shape as the gdpr_erasure_log miss caught in batch 57.)
--
--   2. canary_checks — the periodic canary monitor in
--      utils/canaryHealthCheck.js writes one row per probe; the table
--      didn't exist so every canary run logged "skip" with the 42P01
--      message. Cheap to add and gives ops a queryable history of
--      probe results.
--
--   3. clinical_alerts.acknowledged_at — the canary's
--      "unacknowledged_critical_alerts" probe was failing with
--      `column "acknowledged_at" does not exist`. The columns
--      `acknowledged_by` + `acknowledged_at` are needed for
--      acknowledgement workflow; only `_by` exists today.

BEGIN;

-- ─── hipaa_access_log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hipaa_access_log (
  id                BIGSERIAL PRIMARY KEY,
  accessed_by       UUID,
  accessed_by_role  VARCHAR(40),
  -- patient_id is stored as text rather than uuid because callers across
  -- the codebase pass either the user's uuid or the integer users.id
  -- (depending on which surface raised the audit). Forcing one form
  -- would mean rewriting every caller; storing both lets the BI side
  -- sort them out at query time.
  patient_id        VARCHAR(64),
  record_type       VARCHAR(80),
  action            VARCHAR(40),
  ip_address        VARCHAR(60),
  request_id        VARCHAR(80),
  accessed_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Common access patterns: per-patient lookups, per-actor activity,
-- recent-access heat queries.
CREATE INDEX IF NOT EXISTS idx_hipaa_access_patient_time
  ON hipaa_access_log(patient_id, accessed_at DESC)
  WHERE patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hipaa_access_actor_time
  ON hipaa_access_log(accessed_by, accessed_at DESC)
  WHERE accessed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hipaa_access_recent
  ON hipaa_access_log(accessed_at DESC);

-- ─── canary_checks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canary_checks (
  id          BIGSERIAL PRIMARY KEY,
  checked_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  status      VARCHAR(40) NOT NULL,
  detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_canary_checks_recent
  ON canary_checks(checked_at DESC);

-- ─── clinical_alerts.acknowledged_at ───────────────────────────────────
ALTER TABLE clinical_alerts
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_clinical_alerts_unack
  ON clinical_alerts(created_at)
  WHERE acknowledged_at IS NULL;

COMMIT;
