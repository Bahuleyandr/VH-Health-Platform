-- Migration 140: create staff_messages table.
--
-- Same orphaned-schema pattern as data_breaches (see migration 126b):
-- the table was bootstrapped via an early `prisma db push` so production
-- environments have it silently, but no migration ever created it.
-- A fresh runner-only deploy (verified on dalekdefender 2026-05-02)
-- crashes the messaging inbox endpoint with `relation "staff_messages"
-- does not exist` — every staff member gets HTTP 500 on /messaging/inbox.
--
-- Schema mirrors apps/backend/docs/schema-dump.sql exactly. CREATE /
-- index uses IF NOT EXISTS so this is safe to re-run on environments
-- that already have the table.
--
-- Service callers: messagingService.js (sendMessage / getInbox /
-- getThread / markAsRead / archive) — every staff role's Messages tab
-- depends on this.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_messages (
  id            SERIAL PRIMARY KEY,
  sender_uid    UUID NOT NULL,
  recipient_uid UUID NOT NULL,
  patient_uid   UUID,
  subject       VARCHAR(255),
  body          TEXT NOT NULL,
  priority      VARCHAR(20) DEFAULT 'normal',
  is_read       BOOLEAN DEFAULT false,
  read_at       TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Inbox lookup is "messages where recipient_uid = me ORDER BY created_at DESC"
-- — the partial-index-by-recipient is the hot path. Sender-side history
-- and patient-context filtering are secondary.
CREATE INDEX IF NOT EXISTS idx_staff_messages_recipient
  ON staff_messages (recipient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_messages_sender
  ON staff_messages (sender_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_messages_patient
  ON staff_messages (patient_uid) WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_messages_unread
  ON staff_messages (recipient_uid, is_read) WHERE is_read = false;

COMMIT;
