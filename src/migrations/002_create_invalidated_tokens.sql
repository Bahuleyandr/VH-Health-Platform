-- Token blacklist table for JWT revocation
-- Used by src/utils/tokenBlacklist.js (Redis fast-path + DB persistent fallback)

CREATE TABLE IF NOT EXISTS invalidated_tokens (
  id SERIAL PRIMARY KEY,
  jti VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invalidated_tokens_jti ON invalidated_tokens(jti);
CREATE INDEX IF NOT EXISTS idx_invalidated_tokens_expires_at ON invalidated_tokens(expires_at);
