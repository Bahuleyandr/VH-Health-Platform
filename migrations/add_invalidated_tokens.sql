-- Token blacklist table for JWT revocation
-- Used by token blacklist utility (src/utils/tokenBlacklist.js)
CREATE TABLE IF NOT EXISTS invalidated_tokens (
  jti         VARCHAR(255) PRIMARY KEY,       -- JWT ID (unique per token) or 'user:<uid>' for bulk revocation
  expires_at  TIMESTAMPTZ  NOT NULL,          -- When this entry can be garbage-collected
  reason      VARCHAR(100) DEFAULT 'logout',  -- Why: 'logout', 'refresh_rotation', 'revoke_all_user_tokens', 'admin_action'
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index for cleanup job (delete expired entries)
CREATE INDEX IF NOT EXISTS idx_invalidated_tokens_expires_at ON invalidated_tokens (expires_at);

-- Periodic cleanup: run via cron to prevent table bloat
-- DELETE FROM invalidated_tokens WHERE expires_at < NOW();
