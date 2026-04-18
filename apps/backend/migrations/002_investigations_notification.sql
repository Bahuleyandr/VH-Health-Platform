-- Migration: Add notification tracking columns to investigations table
-- Required by: investigation notification system (backend cron/service)
-- Missing since: initial schema, causing notification errors since 2026-03-25 08:59

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS notified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMP;

-- Index for fast lookups of un-notified investigations
CREATE INDEX IF NOT EXISTS idx_investigations_notified ON investigations(notified) WHERE notified = FALSE;
