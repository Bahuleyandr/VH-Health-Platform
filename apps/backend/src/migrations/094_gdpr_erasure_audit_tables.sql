-- Migration 094: batch-57 — create gdpr_erasure_log + legal_holds tables.
--
-- dataErasureService.js has been writing to gdpr_erasure_log and reading
-- from legal_holds since the GDPR Article-17 surface was added, but
-- neither table existed. The "table might not exist" try/catches in the
-- service silently swallowed the failures:
--   * gdpr_erasure_log INSERT errored every call → audit trail went to a
--     rotating Winston file only (Article 30 record-keeping gap).
--   * legal_holds SELECT errored every call → checkLegalHold() always
--     returned { hasHold: false } regardless of actual holds, so erasure
--     proceeded for users whose data was under regulatory hold.
--
-- Same shape as the clinical_protocols miss caught in batch 56.

BEGIN;

-- ─── gdpr_erasure_log ───────────────────────────────────────────────────
-- One row per Article-17 erasure run. Phone is hashed (never stored
-- plaintext) so the log itself is GDPR-clean.
CREATE TABLE IF NOT EXISTS gdpr_erasure_log (
  id                BIGSERIAL PRIMARY KEY,
  uid               UUID,
  phone_hash        VARCHAR(64),
  requested_by      UUID,
  reason            TEXT,
  ip                VARCHAR(64),
  tables_processed  INTEGER NOT NULL DEFAULT 0,
  completed_at      TIMESTAMP(6) NOT NULL,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  results           JSONB,
  created_at        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gdpr_erasure_log_uid          ON gdpr_erasure_log(uid)          WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gdpr_erasure_log_completed_at ON gdpr_erasure_log(completed_at);
CREATE INDEX IF NOT EXISTS idx_gdpr_erasure_log_requested_by ON gdpr_erasure_log(requested_by) WHERE requested_by IS NOT NULL;

-- ─── legal_holds ────────────────────────────────────────────────────────
-- One row per active hold. Erasure must check this before proceeding.
-- released_at IS NULL means the hold is still active.
CREATE TABLE IF NOT EXISTS legal_holds (
  id           BIGSERIAL PRIMARY KEY,
  user_uid     UUID NOT NULL,
  reason       TEXT NOT NULL,
  created_by   UUID,
  created_at   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at  TIMESTAMP(6),
  released_by  UUID,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_user_uid_active ON legal_holds(user_uid) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_legal_holds_created_at      ON legal_holds(created_at);

COMMIT;
