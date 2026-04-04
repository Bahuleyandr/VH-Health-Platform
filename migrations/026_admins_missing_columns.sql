-- Migration 026: Add missing columns to admins table
-- Columns actively used by authService.js but absent from live DB (2026-04-04)

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS status                VARCHAR(20)                   NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER                       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_login     TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS totp_enabled          BOOLEAN                       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS password_changed_at   TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMP WITHOUT TIME ZONE;

-- Backfill status from is_active
UPDATE admins SET status = CASE WHEN is_active THEN 'active' ELSE 'inactive' END;

-- Backfill updated_at from created_at
UPDATE admins SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_admins_status ON admins(status);
