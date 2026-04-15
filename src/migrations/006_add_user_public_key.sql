-- X25519 public key for end-to-end encrypted messaging. Stored as base64 text
-- because raw bytea would need explicit encoding handling for every query.
-- A user may rotate their key; updated_at lets callers detect when to refetch.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS e2e_public_key     TEXT,
  ADD COLUMN IF NOT EXISTS e2e_key_updated_at TIMESTAMPTZ;
