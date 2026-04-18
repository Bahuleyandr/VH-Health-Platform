-- Migration 021: Schema corrections
-- Fixes column mismatches discovered during DB validation (2026-04-04)
-- All changes are additive (IF NOT EXISTS / IF NOT EXISTS guard) — safe to re-run

-- ===================================================================
-- 1. investigations: add patient_id FK (used by InvestigationNotificationJob)
--    Code: JOIN users u ON i.patient_id = u.id
-- ===================================================================
ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_investigations_patient_id ON investigations(patient_id);


-- ===================================================================
-- 2. pharmacy_orders: add columns referenced by pharmacyOrderController
-- ===================================================================

-- patient_id FK (mirrors investigations pattern)
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- prescription_url (code selects this; DB has prescription_photo_url which is S3 key, not URL)
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS prescription_url TEXT;

-- total_amount (order total for display + billing)
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10, 2) DEFAULT 0;

-- payment_status (pending / paid / refunded)
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'pending';

-- assigned_pharmacist (staff UID who is handling the order)
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS assigned_pharmacist UUID;

-- token_number (queue token for pharmacy counter)
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS token_number VARCHAR(50);

-- created_at (code uses this for ORDER BY and date filtering; ordered_at is the semantic equivalent)
-- Add as a proper column defaulting to NOW(); backfill from ordered_at for existing rows
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITHOUT TIME ZONE;

UPDATE pharmacy_orders
  SET created_at = ordered_at
  WHERE created_at IS NULL;

ALTER TABLE pharmacy_orders
  ALTER COLUMN created_at SET DEFAULT NOW();

-- Indexes for new pharmacy_orders columns
CREATE INDEX IF NOT EXISTS idx_pharmacy_orders_patient_id ON pharmacy_orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_orders_payment_status ON pharmacy_orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_pharmacy_orders_created_at ON pharmacy_orders(created_at DESC);


-- ===================================================================
-- 3. notification_outbox: add retry columns used by notificationOutbox.js
--    Code uses: retry_count, last_attempt_at, failure_reason
--    DB had:    attempts,    last_attempted_at, error_message
-- ===================================================================

-- retry_count (code increments this on failure)
ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

-- Sync existing attempts value into retry_count
UPDATE notification_outbox
  SET retry_count = attempts
  WHERE retry_count = 0 AND attempts > 0;

-- last_attempt_at (code checks: last_attempt_at < NOW() - INTERVAL '5 minutes')
ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP WITHOUT TIME ZONE;

-- Sync from last_attempted_at
UPDATE notification_outbox
  SET last_attempt_at = last_attempted_at
  WHERE last_attempt_at IS NULL AND last_attempted_at IS NOT NULL;

-- failure_reason (code sets this on markFailed())
ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- Sync from error_message
UPDATE notification_outbox
  SET failure_reason = error_message
  WHERE failure_reason IS NULL AND error_message IS NOT NULL;

-- Retry index (migration 019 failed because these cols didn't exist)
CREATE INDEX IF NOT EXISTS idx_notification_outbox_retry
  ON notification_outbox(status, retry_count, last_attempt_at);
